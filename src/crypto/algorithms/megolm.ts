/*
Copyright 2015 - 2021, 2023 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/**
 * Defines m.olm encryption/decryption
 */

import { v4 as uuidv4 } from "uuid";

import type { IEventDecryptionResult, IMegolmSessionData } from "../../@types/crypto";
import { logger, PrefixedLogger } from "../../logger";
import * as olmlib from "../olmlib";
import {
    DecryptionAlgorithm,
    DecryptionClassParams,
    DecryptionError,
    EncryptionAlgorithm,
    IParams,
    registerAlgorithm,
    UnknownDeviceError,
} from "./base";
import { IDecryptedGroupMessage, WITHHELD_MESSAGES } from "../OlmDevice";
import { Room } from "../../models/room";
import { DeviceInfo } from "../deviceinfo";
import { IOlmSessionResult } from "../olmlib";
import { DeviceInfoMap } from "../DeviceList";
import { IContent, MatrixEvent } from "../../models/event";
import { EventType, MsgType, ToDeviceMessageId } from "../../@types/event";
import { IMegolmEncryptedContent, IncomingRoomKeyRequest, IEncryptedContent } from "../index";
import { RoomKeyRequestState } from "../OutgoingRoomKeyRequestManager";
import { OlmGroupSessionExtraData } from "../../@types/crypto";
import { MatrixError } from "../../http-api";
import { immediate } from "../../utils";

// determine whether the key can be shared with invitees
export function isRoomSharedHistory(room: Room): boolean {
    const visibilityEvent = room?.currentState?.getStateEvents("m.room.history_visibility", "");
    // NOTE: if the room visibility is unset, it would normally default to
    // "world_readable".
    // (https://spec.matrix.org/unstable/client-server-api/#server-behaviour-5)
    // But we will be paranoid here, and treat it as a situation where the room
    // is not shared-history
    const visibility = visibilityEvent?.getContent()?.history_visibility;
    return ["world_readable", "shared"].includes(visibility);
}

interface IBlockedDevice {
    code: string;
    reason: string;
    deviceInfo: DeviceInfo;
}

interface IBlockedMap {
    [userId: string]: {
        [deviceId: string]: IBlockedDevice;
    };
}

export interface IOlmDevice<T = DeviceInfo> {
    userId: string;
    deviceInfo: T;
}

export interface IOutboundGroupSessionKey {
    chain_index: number;
    key: string;
}

interface IMessage {
    type: string;
    content: {
        "algorithm": string;
        "room_id": string;
        "sender_key"?: string;
        "sender_claimed_ed25519_key"?: string;
        "session_id": string;
        "session_key": string;
        "chain_index": number;
        "forwarding_curve25519_key_chain"?: string[];
        "org.matrix.msc3061.shared_history": boolean;
    };
}

interface IKeyForwardingMessage extends IMessage {
    type: "m.forwarded_room_key";
}

interface IPayload extends Partial<IMessage> {
    code?: string;
    reason?: string;
    room_id?: string;
    session_id?: string;
    algorithm?: string;
    sender_key?: string;
}

interface SharedWithData {
    // The identity key of the device we shared with
    deviceKey: string;
    // The message index of the ratchet we shared with that device
    messageIndex: number;
}

/**
 * @internal
 */
class OutboundSessionInfo {
    /** number of times this session has been used */
    public useCount = 0;
    /** when the session was created (ms since the epoch) */
    public creationTime: number;
    /** devices with which we have shared the session key `userId -> {deviceId -> SharedWithData}` */
    public sharedWithDevices: Record<string, Record<string, SharedWithData>> = {};
    public blockedDevicesNotified: Record<string, Record<string, boolean>> = {};

    /**
     * @param sharedHistory - whether the session can be freely shared with
     *    other group members, according to the room history visibility settings
     */
    public constructor(public readonly sessionId: string, public readonly sharedHistory = false) {
        this.creationTime = new Date().getTime();
    }

    /**
     * Check if it's time to rotate the session
     */
    public needsRotation(rotationPeriodMsgs: number, rotationPeriodMs: number): boolean {
        const sessionLifetime = new Date().getTime() - this.creationTime;

        if (this.useCount >= rotationPeriodMsgs || sessionLifetime >= rotationPeriodMs) {
            logger.log("Rotating megolm session after " + this.useCount + " messages, " + sessionLifetime + "ms");
            return true;
        }

        return false;
    }

    public markSharedWithDevice(userId: string, deviceId: string, deviceKey: string, chainIndex: number): void {
        if (!this.sharedWithDevices[userId]) {
            this.sharedWithDevices[userId] = {};
        }
        this.sharedWithDevices[userId][deviceId] = { deviceKey, messageIndex: chainIndex };
    }

    public markNotifiedBlockedDevice(userId: string, deviceId: string): void {
        if (!this.blockedDevicesNotified[userId]) {
            this.blockedDevicesNotified[userId] = {};
        }
        this.blockedDevicesNotified[userId][deviceId] = true;
    }

    /**
     * Determine if this session has been shared with devices which it shouldn't
     * have been.
     *
     * @param devicesInRoom - `userId -> {deviceId -> object}`
     *   devices we should shared the session with.
     *
     * @returns true if we have shared the session with devices which aren't
     * in devicesInRoom.
     */
    public sharedWithTooManyDevices(devicesInRoom: Record<string, Record<string, object>>): boolean {
        for (const userId in this.sharedWithDevices) {
            if (!this.sharedWithDevices.hasOwnProperty(userId)) {
                continue;
            }

            if (!devicesInRoom.hasOwnProperty(userId)) {
                logger.log("Starting new megolm session because we shared with " + userId);
                return true;
            }

            for (const deviceId in this.sharedWithDevices[userId]) {
                if (!this.sharedWithDevices[userId].hasOwnProperty(deviceId)) {
                    continue;
                }

                if (!devicesInRoom[userId].hasOwnProperty(deviceId)) {
                    logger.log("Starting new megolm session because we shared with " + userId + ":" + deviceId);
                    return true;
                }
            }
        }

        return false;
    }
}

/**
 * Megolm encryption implementation
 *
 * @param params - parameters, as per {@link EncryptionAlgorithm}
 */
export class MegolmEncryption extends EncryptionAlgorithm {
    // the most recent attempt to set up a session. This is used to serialise
    // the session setups, so that we have a race-free view of which session we
    // are using, and which devices we have shared the keys with. It resolves
    // with an OutboundSessionInfo (or undefined, for the first message in the
    // room).
    private setupPromise = Promise.resolve<OutboundSessionInfo | null>(null);

    // Map of outbound sessions by sessions ID. Used if we need a particular
    // session (the session we're currently using to send is always obtained
    // using setupPromise).
    private outboundSessions: Record<string, OutboundSessionInfo> = {};

    private readonly sessionRotationPeriodMsgs: number;
    private readonly sessionRotationPeriodMs: number;
    private encryptionPreparation?: {
        promise: Promise<void>;
        startTime: number;
        cancel: () => void;
    };

    protected readonly roomId: string;
    private readonly prefixedLogger: PrefixedLogger;

    public constructor(params: IParams & Required<Pick<IParams, "roomId">>) {
        super(params);
        this.roomId = params.roomId;
        this.prefixedLogger = logger.withPrefix(`[${this.roomId} encryption]`);

        this.sessionRotationPeriodMsgs = params.config?.rotation_period_msgs ?? 100;
        this.sessionRotationPeriodMs = params.config?.rotation_period_ms ?? 7 * 24 * 3600 * 1000;
    }

    /**
     * @internal
     *
     * @param devicesInRoom - The devices in this room, indexed by user ID
     * @param blocked - The devices that are blocked, indexed by user ID
     * @param singleOlmCreationPhase - Only perform one round of olm
     *     session creation
     *
     * This method updates the setupPromise field of the class by chaining a new
     * call on top of the existing promise, and then catching and discarding any
     * errors that might happen while setting up the outbound group session. This
     * is done to ensure that `setupPromise` always resolves to `null` or the
     * `OutboundSessionInfo`.
     *
     * Using `>>=` to represent the promise chaining operation, it does the
     * following:
     *
     * ```
     * setupPromise = previousSetupPromise >>= setup >>= discardErrors
     * ```
     *
     * The initial value for the `setupPromise` is a promise that resolves to
     * `null`. The forceDiscardSession() resets setupPromise to this initial
     * promise.
     *
     * @returns Promise which resolves to the
     *    OutboundSessionInfo when setup is complete.
     */
    private async ensureOutboundSession(
        room: Room,
        devicesInRoom: DeviceInfoMap,
        blocked: IBlockedMap,
        singleOlmCreationPhase = false,
    ): Promise<OutboundSessionInfo> {
        // takes the previous OutboundSessionInfo, and considers whether to create
        // a new one. Also shares the key with any (new) devices in the room.
        //
        // returns a promise which resolves once the keyshare is successful.
        const setup = async (oldSession: OutboundSessionInfo | null): Promise<OutboundSessionInfo> => {
            const sharedHistory = isRoomSharedHistory(room);
            const session = await this.prepareSession(devicesInRoom, sharedHistory, oldSession);

            await this.shareSession(devicesInRoom, sharedHistory, singleOlmCreationPhase, blocked, session);

            return session;
        };

        // first wait for the previous share to complete
        const fallible = this.setupPromise.then(setup);

        // Ensure any failures are logged for debugging and make sure that the
        // promise chain remains unbroken
        //
        // setupPromise resolves to `null` or the `OutboundSessionInfo` whether
        // or not the share succeeds
        this.setupPromise = fallible.catch((e) => {
            this.prefixedLogger.error(`Failed to setup outbound session`, e);
            return null;
        });

        // but we return a promise which only resolves if the share was successful.
        return fallible;
    }

    private async prepareSession(
        devicesInRoom: DeviceInfoMap,
        sharedHistory: boolean,
        session: OutboundSessionInfo | null,
    ): Promise<OutboundSessionInfo> {
        // history visibility changed
        if (session && sharedHistory !== session.sharedHistory) {
            session = null;
        }

        // need to make a brand new session?
        if (session?.needsRotation(this.sessionRotationPeriodMsgs, this.sessionRotationPeriodMs)) {
            this.prefixedLogger.log("Starting new megolm session because we need to rotate.");
            session = null;
        }

        // determine if we have shared with anyone we shouldn't have
        if (session?.sharedWithTooManyDevices(devicesInRoom)) {
            session = null;
        }

        if (!session) {
            this.prefixedLogger.log("Starting new megolm session");
            session = await this.prepareNewSession(sharedHistory);
            this.prefixedLogger.log(`Started new megolm session ${session.sessionId}`);
            this.outboundSessions[session.sessionId] = session;
        }

        return session;
    }

    private async shareSession(
        devicesInRoom: DeviceInfoMap,
        sharedHistory: boolean,
        singleOlmCreationPhase: boolean,
        blocked: IBlockedMap,
        session: OutboundSessionInfo,
    ): Promise<void> {
        // now check if we need to share with any devices
        const shareMap: Record<string, DeviceInfo[]> = {};

        for (const [userId, userDevices] of Object.entries(devicesInRoom)) {
            for (const [deviceId, deviceInfo] of Object.entries(userDevices)) {
                const key = deviceInfo.getIdentityKey();
                if (key == this.olmDevice.deviceCurve25519Key) {
                    // don't bother sending to ourself
                    continue;
                }

                if (!session.sharedWithDevices[userId] || session.sharedWithDevices[userId][deviceId] === undefined) {
                    shareMap[userId] = shareMap[userId] || [];
                    shareMap[userId].push(deviceInfo);
                }
            }
        }

        const key = this.olmDevice.getOutboundGroupSessionKey(session.sessionId);
        const payload: IPayload = {
            type: "m.room_key",
            content: {
                "algorithm": olmlib.MEGOLM_ALGORITHM,
                "room_id": this.roomId,
                "session_id": session.sessionId,
                "session_key": key.key,
                "chain_index": key.chain_index,
                "org.matrix.msc3061.shared_history": sharedHistory,
            },
        };
        const [devicesWithoutSession, olmSessions] = await olmlib.getExistingOlmSessions(
            this.olmDevice,
            this.baseApis,
            shareMap,
        );

        await Promise.all([
            (async (): Promise<void> => {
                // share keys with devices that we already have a session for
                const olmSessionList = Object.entries(olmSessions)
                    .map(([userId, sessionsByUser]) =>
                        Object.entries(sessionsByUser).map(
                            ([deviceId, session]) => `${userId}/${deviceId}: ${session.sessionId}`,
                        ),
                    )
                    .flat(1);
                this.prefixedLogger.debug("Sharing keys with devices with existing Olm sessions:", olmSessionList);
                await this.shareKeyWithOlmSessions(session, key, payload, olmSessions);
                this.prefixedLogger.debug("Shared keys with existing Olm sessions");
            })(),
            (async (): Promise<void> => {
                const deviceList = Object.entries(devicesWithoutSession)
                    .map(([userId, devicesByUser]) => devicesByUser.map((device) => `${userId}/${device.deviceId}`))
                    .flat(1);
                this.prefixedLogger.debug(
                    "Sharing keys (start phase 1) with devices without existing Olm sessions:",
                    deviceList,
                );
                const errorDevices: IOlmDevice[] = [];

                // meanwhile, establish olm sessions for devices that we don't
                // already have a session for, and share keys with them.  If
                // we're doing two phases of olm session creation, use a
                // shorter timeout when fetching one-time keys for the first
                // phase.
                const start = Date.now();
                const failedServers: string[] = [];
                await this.shareKeyWithDevices(
                    session,
                    key,
                    payload,
                    devicesWithoutSession,
                    errorDevices,
                    singleOlmCreationPhase ? 10000 : 2000,
                    failedServers,
                );
                this.prefixedLogger.debug("Shared keys (end phase 1) with devices without existing Olm sessions");

                if (!singleOlmCreationPhase && Date.now() - start < 10000) {
                    // perform the second phase of olm session creation if requested,
                    // and if the first phase didn't take too long
                    (async (): Promise<void> => {
                        // Retry sending keys to devices that we were unable to establish
                        // an olm session for.  This time, we use a longer timeout, but we
                        // do this in the background and don't block anything else while we
                        // do this.  We only need to retry users from servers that didn't
                        // respond the first time.
                        const retryDevices: Record<string, DeviceInfo[]> = {};
                        const failedServerMap = new Set();
                        for (const server of failedServers) {
                            failedServerMap.add(server);
                        }
                        const failedDevices: IOlmDevice[] = [];
                        for (const { userId, deviceInfo } of errorDevices) {
                            const userHS = userId.slice(userId.indexOf(":") + 1);
                            if (failedServerMap.has(userHS)) {
                                retryDevices[userId] = retryDevices[userId] || [];
                                retryDevices[userId].push(deviceInfo);
                            } else {
                                // if we aren't going to retry, then handle it
                                // as a failed device
                                failedDevices.push({ userId, deviceInfo });
                            }
                        }

                        const retryDeviceList = Object.entries(retryDevices)
                            .map(([userId, devicesByUser]) =>
                                devicesByUser.map((device) => `${userId}/${device.deviceId}`),
                            )
                            .flat(1);

                        if (retryDeviceList.length > 0) {
                            this.prefixedLogger.debug(
                                "Sharing keys (start phase 2) with devices without existing Olm sessions:",
                                retryDeviceList,
                            );
                            await this.shareKeyWithDevices(session, key, payload, retryDevices, failedDevices, 30000);
                            this.prefixedLogger.debug(
                                "Shared keys (end phase 2) with devices without existing Olm sessions",
                            );
                        }

                        await this.notifyFailedOlmDevices(session, key, failedDevices);
                    })();
                } else {
                    await this.notifyFailedOlmDevices(session, key, errorDevices);
                }
            })(),
            (async (): Promise<void> => {
                this.prefixedLogger.debug(
                    `There are ${Object.entries(blocked).length} blocked devices:`,
                    Object.entries(blocked)
                        .map(([userId, blockedByUser]) =>
                            Object.entries(blockedByUser).map(([deviceId, _deviceInfo]) => `${userId}/${deviceId}`),
                        )
                        .flat(1),
                );

                // also, notify newly blocked devices that they're blocked
                const blockedMap: Record<string, Record<string, { device: IBlockedDevice }>> = {};
                let blockedCount = 0;
                for (const [userId, userBlockedDevices] of Object.entries(blocked)) {
                    for (const [deviceId, device] of Object.entries(userBlockedDevices)) {
                        if (
                            !session.blockedDevicesNotified[userId] ||
                            session.blockedDevicesNotified[userId][deviceId] === undefined
                        ) {
                            blockedMap[userId] = blockedMap[userId] || {};
                            blockedMap[userId][deviceId] = { device };
                            blockedCount++;
                        }
                    }
                }

                if (blockedCount) {
                    this.prefixedLogger.debug(
                        `Notifying ${blockedCount} newly blocked devices:`,
                        Object.entries(blockedMap)
                            .map(([userId, blockedByUser]) =>
                                Object.entries(blockedByUser).map(([deviceId, _deviceInfo]) => `${userId}/${deviceId}`),
                            )
                            .flat(1),
                    );
                    await this.notifyBlockedDevices(session, blockedMap);
                    this.prefixedLogger.debug(`Notified ${blockedCount} newly blocked devices`);
                }
            })(),
        ]);
    }

    /**
     * @internal
     *
     *
     * @returns session
     */
    private async prepareNewSession(sharedHistory: boolean): Promise<OutboundSessionInfo> {
        const sessionId = this.olmDevice.createOutboundGroupSession();
        const key = this.olmDevice.getOutboundGroupSessionKey(sessionId);

        await this.olmDevice.addInboundGroupSession(
            this.roomId,
            this.olmDevice.deviceCurve25519Key!,
            [],
            sessionId,
            key.key,
            { ed25519: this.olmDevice.deviceEd25519Key! },
            false,
            { sharedHistory },
        );

        // don't wait for it to complete
        this.crypto.backupManager.backupGroupSession(this.olmDevice.deviceCurve25519Key!, sessionId);

        return new OutboundSessionInfo(sessionId, sharedHistory);
    }

    /**
     * Determines what devices in devicesByUser don't have an olm session as given
     * in devicemap.
     *
     * @internal
     *
     * @param devicemap - the devices that have olm sessions, as returned by
     *     olmlib.ensureOlmSessionsForDevices.
     * @param devicesByUser - a map of user IDs to array of deviceInfo
     * @param noOlmDevices - an array to fill with devices that don't have
     *     olm sessions
     *
     * @returns an array of devices that don't have olm sessions.  If
     *     noOlmDevices is specified, then noOlmDevices will be returned.
     */
    private getDevicesWithoutSessions(
        devicemap: Record<string, Record<string, IOlmSessionResult>>,
        devicesByUser: Record<string, DeviceInfo[]>,
        noOlmDevices: IOlmDevice[] = [],
    ): IOlmDevice[] {
        for (const [userId, devicesToShareWith] of Object.entries(devicesByUser)) {
            const sessionResults = devicemap[userId];

            for (const deviceInfo of devicesToShareWith) {
                const deviceId = deviceInfo.deviceId;

                const sessionResult = sessionResults[deviceId];
                if (!sessionResult.sessionId) {
                    // no session with this device, probably because there
                    // were no one-time keys.

                    noOlmDevices.push({ userId, deviceInfo });
                    delete sessionResults[deviceId];

                    // ensureOlmSessionsForUsers has already done the logging,
                    // so just skip it.
                    continue;
                }
            }
        }

        return noOlmDevices;
    }

    /**
     * Splits the user device map into multiple chunks to reduce the number of
     * devices we encrypt to per API call.
     *
     * @internal
     *
     * @param devicesByUser - map from userid to list of devices
     *
     * @returns the blocked devices, split into chunks
     */
    private splitDevices<T extends DeviceInfo | IBlockedDevice>(
        devicesByUser: Record<string, Record<string, { device: T }>>,
    ): IOlmDevice<T>[][] {
        const maxDevicesPerRequest = 20;

        // use an array where the slices of a content map gets stored
        let currentSlice: IOlmDevice<T>[] = [];
        const mapSlices = [currentSlice];

        for (const [userId, userDevices] of Object.entries(devicesByUser)) {
            for (const deviceInfo of Object.values(userDevices)) {
                currentSlice.push({
                    userId: userId,
                    deviceInfo: deviceInfo.device,
                });
            }

            // We do this in the per-user loop as we prefer that all messages to the
            // same user end up in the same API call to make it easier for the
            // server (e.g. only have to send one EDU if a remote user, etc). This
            // does mean that if a user has many devices we may go over the desired
            // limit, but its not a hard limit so that is fine.
            if (currentSlice.length > maxDevicesPerRequest) {
                // the current slice is filled up. Start inserting into the next slice
                currentSlice = [];
                mapSlices.push(currentSlice);
            }
        }
        if (currentSlice.length === 0) {
            mapSlices.pop();
        }
        return mapSlices;
    }

    /**
     * @internal
     *
     *
     * @param chainIndex - current chain index
     *
     * @param userDeviceMap - mapping from userId to deviceInfo
     *
     * @param payload - fields to include in the encrypted payload
     *
     * @returns Promise which resolves once the key sharing
     *     for the given userDeviceMap is generated and has been sent.
     */
    private encryptAndSendKeysToDevices(
        session: OutboundSessionInfo,
        chainIndex: number,
        devices: IOlmDevice[],
        payload: IPayload,
    ): Promise<void> {
        return this.crypto
            .encryptAndSendToDevices(devices, payload)
            .then(() => {
                // store that we successfully uploaded the keys of the current slice
                for (const device of devices) {
                    session.markSharedWithDevice(
                        device.userId,
                        device.deviceInfo.deviceId,
                        device.deviceInfo.getIdentityKey(),
                        chainIndex,
                    );
                }
            })
            .catch((error) => {
                this.prefixedLogger.error("failed to encryptAndSendToDevices", error);
                throw error;
            });
    }

    /**
     * @internal
     *
     *
     * @param userDeviceMap - list of blocked devices to notify
     *
     * @param payload - fields to include in the notification payload
     *
     * @returns Promise which resolves once the notifications
     *     for the given userDeviceMap is generated and has been sent.
     */
    private async sendBlockedNotificationsToDevices(
        session: OutboundSessionInfo,
        userDeviceMap: IOlmDevice<IBlockedDevice>[],
        payload: IPayload,
    ): Promise<void> {
        const contentMap: Record<string, Record<string, IPayload>> = {};

        for (const val of userDeviceMap) {
            const userId = val.userId;
            const blockedInfo = val.deviceInfo;
            const deviceInfo = blockedInfo.deviceInfo;
            const deviceId = deviceInfo.deviceId;

            const message = {
                ...payload,
                code: blockedInfo.code,
                reason: blockedInfo.reason,
                [ToDeviceMessageId]: uuidv4(),
            };

            if (message.code === "m.no_olm") {
                delete message.room_id;
                delete message.session_id;
            }

            if (!contentMap[userId]) {
                contentMap[userId] = {};
            }
            contentMap[userId][deviceId] = message;
        }

        await this.baseApis.sendToDevice("m.room_key.withheld", contentMap);

        // record the fact that we notified these blocked devices
        for (const userId of Object.keys(contentMap)) {
            for (const deviceId of Object.keys(contentMap[userId])) {
                session.markNotifiedBlockedDevice(userId, deviceId);
            }
        }
    }

    /**
     * Re-shares a megolm session key with devices if the key has already been
     * sent to them.
     *
     * @param senderKey - The key of the originating device for the session
     * @param sessionId - ID of the outbound session to share
     * @param userId - ID of the user who owns the target device
     * @param device - The target device
     */
    public async reshareKeyWithDevice(
        senderKey: string,
        sessionId: string,
        userId: string,
        device: DeviceInfo,
    ): Promise<void> {
        const obSessionInfo = this.outboundSessions[sessionId];
        if (!obSessionInfo) {
            this.prefixedLogger.debug(`megolm session ${senderKey}|${sessionId} not found: not re-sharing keys`);
            return;
        }

        // The chain index of the key we previously sent this device
        if (obSessionInfo.sharedWithDevices[userId] === undefined) {
            this.prefixedLogger.debug(`megolm session ${senderKey}|${sessionId} never shared with user ${userId}`);
            return;
        }
        const sessionSharedData = obSessionInfo.sharedWithDevices[userId][device.deviceId];
        if (sessionSharedData === undefined) {
            this.prefixedLogger.debug(
                `megolm session ${senderKey}|${sessionId} never shared with device ${userId}:${device.deviceId}`,
            );
            return;
        }

        if (sessionSharedData.deviceKey !== device.getIdentityKey()) {
            this.prefixedLogger.warn(
                `Megolm session ${senderKey}|${sessionId} has been shared with device ${device.deviceId} but ` +
                    `with identity key ${sessionSharedData.deviceKey}. Key is now ${device.getIdentityKey()}!`,
            );
            return;
        }

        // get the key from the inbound session: the outbound one will already
        // have been ratcheted to the next chain index.
        const key = await this.olmDevice.getInboundGroupSessionKey(
            this.roomId,
            senderKey,
            sessionId,
            sessionSharedData.messageIndex,
        );

        if (!key) {
            this.prefixedLogger.warn(
                `No inbound session key found for megolm session ${senderKey}|${sessionId}: not re-sharing keys`,
            );
            return;
        }

        await olmlib.ensureOlmSessionsForDevices(this.olmDevice, this.baseApis, {
            [userId]: [device],
        });

        const payload = {
            type: "m.forwarded_room_key",
            content: {
                "algorithm": olmlib.MEGOLM_ALGORITHM,
                "room_id": this.roomId,
                "session_id": sessionId,
                "session_key": key.key,
                "chain_index": key.chain_index,
                "sender_key": senderKey,
                "sender_claimed_ed25519_key": key.sender_claimed_ed25519_key,
                "forwarding_curve25519_key_chain": key.forwarding_curve25519_key_chain,
                "org.matrix.msc3061.shared_history": key.shared_history || false,
            },
        };

        const encryptedContent: IEncryptedContent = {
            algorithm: olmlib.OLM_ALGORITHM,
            sender_key: this.olmDevice.deviceCurve25519Key!,
            ciphertext: {},
            [ToDeviceMessageId]: uuidv4(),
        };
        await olmlib.encryptMessageForDevice(
            encryptedContent.ciphertext,
            this.userId,
            this.deviceId,
            this.olmDevice,
            userId,
            device,
            payload,
        );

        await this.baseApis.sendToDevice("m.room.encrypted", {
            [userId]: {
                [device.deviceId]: encryptedContent,
            },
        });
        this.prefixedLogger.debug(
            `Re-shared key for megolm session ${senderKey}|${sessionId} with ${userId}:${device.deviceId}`,
        );
    }

    /**
     * @internal
     *
     *
     * @param key - the session key as returned by
     *    OlmDevice.getOutboundGroupSessionKey
     *
     * @param payload - the base to-device message payload for sharing keys
     *
     * @param devicesByUser - map from userid to list of devices
     *
     * @param errorDevices - array that will be populated with the devices that we can't get an
     *    olm session for
     *
     * @param otkTimeout - The timeout in milliseconds when requesting
     *     one-time keys for establishing new olm sessions.
     *
     * @param failedServers - An array to fill with remote servers that
     *     failed to respond to one-time-key requests.
     */
    private async shareKeyWithDevices(
        session: OutboundSessionInfo,
        key: IOutboundGroupSessionKey,
        payload: IPayload,
        devicesByUser: Record<string, DeviceInfo[]>,
        errorDevices: IOlmDevice[],
        otkTimeout: number,
        failedServers?: string[],
    ): Promise<void> {
        const devicemap = await olmlib.ensureOlmSessionsForDevices(
            this.olmDevice,
            this.baseApis,
            devicesByUser,
            false,
            otkTimeout,
            failedServers,
            this.prefixedLogger,
        );
        this.getDevicesWithoutSessions(devicemap, devicesByUser, errorDevices);
        await this.shareKeyWithOlmSessions(session, key, payload, devicemap);
    }

    private async shareKeyWithOlmSessions(
        session: OutboundSessionInfo,
        key: IOutboundGroupSessionKey,
        payload: IPayload,
        devicemap: Record<string, Record<string, IOlmSessionResult>>,
    ): Promise<void> {
        const userDeviceMaps = this.splitDevices(devicemap);

        for (let i = 0; i < userDeviceMaps.length; i++) {
            const taskDetail = `megolm keys for ${session.sessionId} (slice ${i + 1}/${userDeviceMaps.length})`;
            try {
                this.prefixedLogger.debug(
                    `Sharing ${taskDetail}`,
                    userDeviceMaps[i].map((d) => `${d.userId}/${d.deviceInfo.deviceId}`),
                );
                await this.encryptAndSendKeysToDevices(session, key.chain_index, userDeviceMaps[i], payload);
                this.prefixedLogger.debug(`Shared ${taskDetail}`);
            } catch (e) {
                this.prefixedLogger.error(`Failed to share ${taskDetail}`);
                throw e;
            }
        }
    }

    /**
     * Notify devices that we weren't able to create olm sessions.
     *
     *
     *
     * @param failedDevices - the devices that we were unable to
     *     create olm sessions for, as returned by shareKeyWithDevices
     */
    private async notifyFailedOlmDevices(
        session: OutboundSessionInfo,
        key: IOutboundGroupSessionKey,
        failedDevices: IOlmDevice[],
    ): Promise<void> {
        this.prefixedLogger.debug(`Notifying ${failedDevices.length} devices we failed to create Olm sessions`);

        // mark the devices that failed as "handled" because we don't want to try
        // to claim a one-time-key for dead devices on every message.
        for (const { userId, deviceInfo } of failedDevices) {
            const deviceId = deviceInfo.deviceId;

            session.markSharedWithDevice(userId, deviceId, deviceInfo.getIdentityKey(), key.chain_index);
        }

        const unnotifiedFailedDevices = await this.olmDevice.filterOutNotifiedErrorDevices(failedDevices);
        this.prefixedLogger.debug(
            `Need to notify ${unnotifiedFailedDevices.length} failed devices which haven't been notified before`,
        );
        const blockedMap: Record<string, Record<string, { device: IBlockedDevice }>> = {};
        for (const { userId, deviceInfo } of unnotifiedFailedDevices) {
            blockedMap[userId] = blockedMap[userId] || {};
            // we use a similar format to what
            // olmlib.ensureOlmSessionsForDevices returns, so that
            // we can use the same function to split
            blockedMap[userId][deviceInfo.deviceId] = {
                device: {
                    code: "m.no_olm",
                    reason: WITHHELD_MESSAGES["m.no_olm"],
                    deviceInfo,
                },
            };
        }

        // send the notifications
        await this.notifyBlockedDevices(session, blockedMap);
        this.prefixedLogger.debug(
            `Notified ${unnotifiedFailedDevices.length} devices we failed to create Olm sessions`,
        );
    }

    /**
     * Notify blocked devices that they have been blocked.
     *
     *
     * @param devicesByUser - map from userid to device ID to blocked data
     */
    private async notifyBlockedDevices(
        session: OutboundSessionInfo,
        devicesByUser: Record<string, Record<string, { device: IBlockedDevice }>>,
    ): Promise<void> {
        const payload: IPayload = {
            room_id: this.roomId,
            session_id: session.sessionId,
            algorithm: olmlib.MEGOLM_ALGORITHM,
            sender_key: this.olmDevice.deviceCurve25519Key!,
        };

        const userDeviceMaps = this.splitDevices(devicesByUser);

        for (let i = 0; i < userDeviceMaps.length; i++) {
            try {
                await this.sendBlockedNotificationsToDevices(session, userDeviceMaps[i], payload);
                this.prefixedLogger.log(
                    `Completed blacklist notification for ${session.sessionId} ` +
                        `(slice ${i + 1}/${userDeviceMaps.length})`,
                );
            } catch (e) {
                this.prefixedLogger.log(
                    `blacklist notification for ${session.sessionId} ` +
                        `(slice ${i + 1}/${userDeviceMaps.length}) failed`,
                );

                throw e;
            }
        }
    }

    /**
     * Perform any background tasks that can be done before a message is ready to
     * send, in order to speed up sending of the message.
     *
     * @param room - the room the event is in
     * @returns A function that, when called, will stop the preparation
     */
    public prepareToEncrypt(room: Room): () => void {
        if (room.roomId !== this.roomId) {
            throw new Error("MegolmEncryption.prepareToEncrypt called on unexpected room");
        }

        if (this.encryptionPreparation != null) {
            // We're already preparing something, so don't do anything else.
            const elapsedTime = Date.now() - this.encryptionPreparation.startTime;
            this.prefixedLogger.debug(
                `Already started preparing to encrypt for this room ${elapsedTime}ms ago, skipping`,
            );
            return this.encryptionPreparation.cancel;
        }

        this.prefixedLogger.debug("Preparing to encrypt events");

        let cancelled = false;
        const isCancelled = (): boolean => cancelled;

        this.encryptionPreparation = {
            startTime: Date.now(),
            promise: (async (): Promise<void> => {
                try {
                    // Attempt to enumerate the devices in room, and gracefully
                    // handle cancellation if it occurs.
                    const getDevicesResult = await this.getDevicesInRoom(room, false, isCancelled);
                    if (getDevicesResult === null) return;
                    const [devicesInRoom, blocked] = getDevicesResult;

                    if (this.crypto.globalErrorOnUnknownDevices) {
                        // Drop unknown devices for now.  When the message gets sent, we'll
                        // throw an error, but we'll still be prepared to send to the known
                        // devices.
                        this.removeUnknownDevices(devicesInRoom);
                    }

                    this.prefixedLogger.debug("Ensuring outbound megolm session");
                    await this.ensureOutboundSession(room, devicesInRoom, blocked, true);

                    this.prefixedLogger.debug("Ready to encrypt events");
                } catch (e) {
                    this.prefixedLogger.error("Failed to prepare to encrypt events", e);
                } finally {
                    delete this.encryptionPreparation;
                }
            })(),

            cancel: (): void => {
                // The caller has indicated that the process should be cancelled,
                // so tell the promise that we'd like to halt, and reset the preparation state.
                cancelled = true;
                delete this.encryptionPreparation;
            },
        };

        return this.encryptionPreparation.cancel;
    }

    /**
     * @param content - plaintext event content
     *
     * @returns Promise which resolves to the new event body
     */
    public async encryptMessage(room: Room, eventType: string, content: IContent): Promise<IMegolmEncryptedContent> {
        this.prefixedLogger.log("Starting to encrypt event");

        if (this.encryptionPreparation != null) {
            // If we started sending keys, wait for it to be done.
            // FIXME: check if we need to cancel
            // (https://github.com/matrix-org/matrix-js-sdk/issues/1255)
            try {
                await this.encryptionPreparation.promise;
            } catch (e) {
                // ignore any errors -- if the preparation failed, we'll just
                // restart everything here
            }
        }

        /**
         * When using in-room messages and the room has encryption enabled,
         * clients should ensure that encryption does not hinder the verification.
         */
        const forceDistributeToUnverified = this.isVerificationEvent(eventType, content);
        const [devicesInRoom, blocked] = await this.getDevicesInRoom(room, forceDistributeToUnverified);

        // check if any of these devices are not yet known to the user.
        // if so, warn the user so they can verify or ignore.
        if (this.crypto.globalErrorOnUnknownDevices) {
            this.checkForUnknownDevices(devicesInRoom);
        }

        const session = await this.ensureOutboundSession(room, devicesInRoom, blocked);
        const payloadJson = {
            room_id: this.roomId,
            type: eventType,
            content: content,
        };

        const ciphertext = this.olmDevice.encryptGroupMessage(session.sessionId, JSON.stringify(payloadJson));
        const encryptedContent: IEncryptedContent = {
            algorithm: olmlib.MEGOLM_ALGORITHM,
            sender_key: this.olmDevice.deviceCurve25519Key!,
            ciphertext: ciphertext,
            session_id: session.sessionId,
            // Include our device ID so that recipients can send us a
            // m.new_device message if they don't have our session key.
            // XXX: Do we still need this now that m.new_device messages
            // no longer exist since #483?
            device_id: this.deviceId,
        };

        session.useCount++;
        return encryptedContent;
    }

    private isVerificationEvent(eventType: string, content: IContent): boolean {
        switch (eventType) {
            case EventType.KeyVerificationCancel:
            case EventType.KeyVerificationDone:
            case EventType.KeyVerificationMac:
            case EventType.KeyVerificationStart:
            case EventType.KeyVerificationKey:
            case EventType.KeyVerificationReady:
            case EventType.KeyVerificationAccept: {
                return true;
            }
            case EventType.RoomMessage: {
                return content["msgtype"] === MsgType.KeyVerificationRequest;
            }
            default: {
                return false;
            }
        }
    }

    /**
     * Forces the current outbound group session to be discarded such
     * that another one will be created next time an event is sent.
     *
     * This should not normally be necessary.
     */
    public forceDiscardSession(): void {
        this.setupPromise = this.setupPromise.then(() => null);
    }

    /**
     * Checks the devices we're about to send to and see if any are entirely
     * unknown to the user.  If so, warn the user, and mark them as known to
     * give the user a chance to go verify them before re-sending this message.
     *
     * @param devicesInRoom - `userId -> {deviceId -> object}`
     *   devices we should shared the session with.
     */
    private checkForUnknownDevices(devicesInRoom: DeviceInfoMap): void {
        const unknownDevices: Record<string, Record<string, DeviceInfo>> = {};

        Object.keys(devicesInRoom).forEach((userId) => {
            Object.keys(devicesInRoom[userId]).forEach((deviceId) => {
                const device = devicesInRoom[userId][deviceId];
                if (device.isUnverified() && !device.isKnown()) {
                    if (!unknownDevices[userId]) {
                        unknownDevices[userId] = {};
                    }
                    unknownDevices[userId][deviceId] = device;
                }
            });
        });

        if (Object.keys(unknownDevices).length) {
            // it'd be kind to pass unknownDevices up to the user in this error
            throw new UnknownDeviceError(
                "This room contains unknown devices which have not been verified. " +
                    "We strongly recommend you verify them before continuing.",
                unknownDevices,
            );
        }
    }

    /**
     * Remove unknown devices from a set of devices.  The devicesInRoom parameter
     * will be modified.
     *
     * @param devicesInRoom - `userId -> {deviceId -> object}`
     *   devices we should shared the session with.
     */
    private removeUnknownDevices(devicesInRoom: DeviceInfoMap): void {
        for (const [userId, userDevices] of Object.entries(devicesInRoom)) {
            for (const [deviceId, device] of Object.entries(userDevices)) {
                if (device.isUnverified() && !device.isKnown()) {
                    delete userDevices[deviceId];
                }
            }

            if (Object.keys(userDevices).length === 0) {
                delete devicesInRoom[userId];
            }
        }
    }

    /**
     * Get the list of unblocked devices for all users in the room
     *
     * @param forceDistributeToUnverified - if set to true will include the unverified devices
     * even if setting is set to block them (useful for verification)
     * @param isCancelled - will cause the procedure to abort early if and when it starts
     * returning `true`. If omitted, cancellation won't happen.
     *
     * @returns Promise which resolves to `null`, or an array whose
     *     first element is a {@link DeviceInfoMap} indicating
     *     the devices that messages should be encrypted to, and whose second
     *     element is a map from userId to deviceId to data indicating the devices
     *     that are in the room but that have been blocked.
     *     If `isCancelled` is provided and returns `true` while processing, `null`
     *     will be returned.
     *     If `isCancelled` is not provided, the Promise will never resolve to `null`.
     */
    private async getDevicesInRoom(
        room: Room,
        forceDistributeToUnverified?: boolean,
    ): Promise<[DeviceInfoMap, IBlockedMap]>;
    private async getDevicesInRoom(
        room: Room,
        forceDistributeToUnverified?: boolean,
        isCancelled?: () => boolean,
    ): Promise<null | [DeviceInfoMap, IBlockedMap]>;
    private async getDevicesInRoom(
        room: Room,
        forceDistributeToUnverified = false,
        isCancelled?: () => boolean,
    ): Promise<null | [DeviceInfoMap, IBlockedMap]> {
        const members = await room.getEncryptionTargetMembers();
        this.prefixedLogger.debug(
            `Encrypting for users (shouldEncryptForInvitedMembers: ${room.shouldEncryptForInvitedMembers()}):`,
            members.map((u) => `${u.userId} (${u.membership})`),
        );

        const roomMembers = members.map(function (u) {
            return u.userId;
        });

        // The global value is treated as a default for when rooms don't specify a value.
        let isBlacklisting = this.crypto.globalBlacklistUnverifiedDevices;
        const isRoomBlacklisting = room.getBlacklistUnverifiedDevices();
        if (typeof isRoomBlacklisting === "boolean") {
            isBlacklisting = isRoomBlacklisting;
        }

        // We are happy to use a cached version here: we assume that if we already
        // have a list of the user's devices, then we already share an e2e room
        // with them, which means that they will have announced any new devices via
        // device_lists in their /sync response.  This cache should then be maintained
        // using all the device_lists changes and left fields.
        // See https://github.com/vector-im/element-web/issues/2305 for details.
        const devices = await this.crypto.downloadKeys(roomMembers, false);
        const blocked: IBlockedMap = {};

        if (isCancelled?.() === true) {
            return null;
        }

        // remove any blocked devices
        for (const userId in devices) {
            if (!devices.hasOwnProperty(userId)) {
                continue;
            }

            const userDevices = devices[userId];
            for (const deviceId in userDevices) {
                if (!userDevices.hasOwnProperty(deviceId)) {
                    continue;
                }

                // Yield prior to checking each device so that we don't block
                // updating/rendering for too long.
                // See https://github.com/vector-im/element-web/issues/21612
                if (isCancelled !== undefined) await immediate();
                if (isCancelled?.() === true) return null;
                const deviceTrust = this.crypto.checkDeviceTrust(userId, deviceId);

                if (
                    userDevices[deviceId].isBlocked() ||
                    (!deviceTrust.isVerified() && isBlacklisting && !forceDistributeToUnverified)
                ) {
                    if (!blocked[userId]) {
                        blocked[userId] = {};
                    }
                    const isBlocked = userDevices[deviceId].isBlocked();
                    blocked[userId][deviceId] = {
                        code: isBlocked ? "m.blacklisted" : "m.unverified",
                        reason: WITHHELD_MESSAGES[isBlocked ? "m.blacklisted" : "m.unverified"],
                        deviceInfo: userDevices[deviceId],
                    };
                    delete userDevices[deviceId];
                }
            }
        }

        return [devices, blocked];
    }
}

/**
 * Megolm decryption implementation
 *
 * @param params - parameters, as per {@link DecryptionAlgorithm}
 */
export class MegolmDecryption extends DecryptionAlgorithm {
    // events which we couldn't decrypt due to unknown sessions /
    // indexes, or which we could only decrypt with untrusted keys:
    // map from senderKey|sessionId to Set of MatrixEvents
    private pendingEvents = new Map<string, Map<string, Set<MatrixEvent>>>();

    // this gets stubbed out by the unit tests.
    private olmlib = olmlib;

    protected readonly roomId: string;
    private readonly prefixedLogger: PrefixedLogger;

    public constructor(params: DecryptionClassParams<IParams & Required<Pick<IParams, "roomId">>>) {
        super(params);
        this.roomId = params.roomId;
        this.prefixedLogger = logger.withPrefix(`[${this.roomId} decryption]`);
    }

    /**
     * returns a promise which resolves to a
     * {@link EventDecryptionResult} once we have finished
     * decrypting, or rejects with an `algorithms.DecryptionError` if there is a
     * problem decrypting the event.
     */
    public async decryptEvent(event: MatrixEvent): Promise<IEventDecryptionResult> {
        const content = event.getWireContent();

        if (!content.sender_key || !content.session_id || !content.ciphertext) {
            throw new DecryptionError("MEGOLM_MISSING_FIELDS", "Missing fields in input");
        }

        // we add the event to the pending list *before* we start decryption.
        //
        // then, if the key turns up while decryption is in progress (and
        // decryption fails), we will schedule a retry.
        // (fixes https://github.com/vector-im/element-web/issues/5001)
        this.addEventToPendingList(event);

        let res: IDecryptedGroupMessage | null;
        try {
            res = await this.olmDevice.decryptGroupMessage(
                event.getRoomId()!,
                content.sender_key,
                content.session_id,
                content.ciphertext,
                event.getId()!,
                event.getTs(),
            );
        } catch (e) {
            if ((<Error>e).name === "DecryptionError") {
                // re-throw decryption errors as-is
                throw e;
            }

            let errorCode = "OLM_DECRYPT_GROUP_MESSAGE_ERROR";

            if ((<MatrixError>e)?.message === "OLM.UNKNOWN_MESSAGE_INDEX") {
                this.requestKeysForEvent(event);

                errorCode = "OLM_UNKNOWN_MESSAGE_INDEX";
            }

            throw new DecryptionError(errorCode, e ? e.toString() : "Unknown Error: Error is undefined", {
                session: content.sender_key + "|" + content.session_id,
            });
        }

        if (res === null) {
            // We've got a message for a session we don't have.
            // try and get the missing key from the backup first
            this.crypto.backupManager.queryKeyBackupRateLimited(event.getRoomId(), content.session_id).catch(() => {});

            // (XXX: We might actually have received this key since we started
            // decrypting, in which case we'll have scheduled a retry, and this
            // request will be redundant. We could probably check to see if the
            // event is still in the pending list; if not, a retry will have been
            // scheduled, so we needn't send out the request here.)
            this.requestKeysForEvent(event);

            // See if there was a problem with the olm session at the time the
            // event was sent.  Use a fuzz factor of 2 minutes.
            const problem = await this.olmDevice.sessionMayHaveProblems(content.sender_key, event.getTs() - 120000);
            if (problem) {
                this.prefixedLogger.info(
                    `When handling UISI from ${event.getSender()} (sender key ${content.sender_key}): ` +
                        `recent session problem with that sender: ${problem}`,
                );
                let problemDescription = PROBLEM_DESCRIPTIONS[problem.type as "no_olm"] || PROBLEM_DESCRIPTIONS.unknown;
                if (problem.fixed) {
                    problemDescription += " Trying to create a new secure channel and re-requesting the keys.";
                }
                throw new DecryptionError("MEGOLM_UNKNOWN_INBOUND_SESSION_ID", problemDescription, {
                    session: content.sender_key + "|" + content.session_id,
                });
            }

            throw new DecryptionError(
                "MEGOLM_UNKNOWN_INBOUND_SESSION_ID",
                "The sender's device has not sent us the keys for this message.",
                {
                    session: content.sender_key + "|" + content.session_id,
                },
            );
        }

        // Success. We can remove the event from the pending list, if
        // that hasn't already happened. However, if the event was
        // decrypted with an untrusted key, leave it on the pending
        // list so it will be retried if we find a trusted key later.
        if (!res.untrusted) {
            this.removeEventFromPendingList(event);
        }

        const payload = JSON.parse(res.result);

        // belt-and-braces check that the room id matches that indicated by the HS
        // (this is somewhat redundant, since the megolm session is scoped to the
        // room, so neither the sender nor a MITM can lie about the room_id).
        if (payload.room_id !== event.getRoomId()) {
            throw new DecryptionError("MEGOLM_BAD_ROOM", "Message intended for room " + payload.room_id);
        }

        return {
            clearEvent: payload,
            senderCurve25519Key: res.senderKey,
            claimedEd25519Key: res.keysClaimed.ed25519,
            forwardingCurve25519KeyChain: res.forwardingCurve25519KeyChain,
            untrusted: res.untrusted,
        };
    }

    private requestKeysForEvent(event: MatrixEvent): void {
        const wireContent = event.getWireContent();

        const recipients = event.getKeyRequestRecipients(this.userId);

        this.crypto.requestRoomKey(
            {
                room_id: event.getRoomId()!,
                algorithm: wireContent.algorithm,
                sender_key: wireContent.sender_key,
                session_id: wireContent.session_id,
            },
            recipients,
        );
    }

    /**
     * Add an event to the list of those awaiting their session keys.
     *
     * @internal
     *
     */
    private addEventToPendingList(event: MatrixEvent): void {
        const content = event.getWireContent();
        const senderKey = content.sender_key;
        const sessionId = content.session_id;
        if (!this.pendingEvents.has(senderKey)) {
            this.pendingEvents.set(senderKey, new Map<string, Set<MatrixEvent>>());
        }
        const senderPendingEvents = this.pendingEvents.get(senderKey)!;
        if (!senderPendingEvents.has(sessionId)) {
            senderPendingEvents.set(sessionId, new Set());
        }
        senderPendingEvents.get(sessionId)?.add(event);
    }

    /**
     * Remove an event from the list of those awaiting their session keys.
     *
     * @internal
     *
     */
    private removeEventFromPendingList(event: MatrixEvent): void {
        const content = event.getWireContent();
        const senderKey = content.sender_key;
        const sessionId = content.session_id;
        const senderPendingEvents = this.pendingEvents.get(senderKey);
        const pendingEvents = senderPendingEvents?.get(sessionId);
        if (!pendingEvents) {
            return;
        }

        pendingEvents.delete(event);
        if (pendingEvents.size === 0) {
            senderPendingEvents!.delete(sessionId);
        }
        if (senderPendingEvents!.size === 0) {
            this.pendingEvents.delete(senderKey);
        }
    }

    public async onRoomKeyEvent(event: MatrixEvent): Promise<void> {
        const content = event.getContent<Partial<IMessage["content"]>>();
        let senderKey = event.getSenderKey()!;
        let forwardingKeyChain: string[] = [];
        let exportFormat = false;
        let keysClaimed: ReturnType<MatrixEvent["getKeysClaimed"]>;

        const extraSessionData: OlmGroupSessionExtraData = {};

        if (!content.room_id || !content.session_key || !content.session_id || !content.algorithm) {
            this.prefixedLogger.error("key event is missing fields");
            return;
        }

        if (!olmlib.isOlmEncrypted(event)) {
            this.prefixedLogger.error("key event not properly encrypted");
            return;
        }

        if (content["org.matrix.msc3061.shared_history"]) {
            extraSessionData.sharedHistory = true;
        }

        if (event.getType() == "m.forwarded_room_key") {
            const deviceInfo = this.crypto.deviceList.getDeviceByIdentityKey(olmlib.OLM_ALGORITHM, senderKey);
            const senderKeyUser = this.baseApis.crypto!.deviceList.getUserByIdentityKey(
                olmlib.OLM_ALGORITHM,
                senderKey,
            );
            if (senderKeyUser !== event.getSender()) {
                this.prefixedLogger.error("sending device does not belong to the user it claims to be from");
                return;
            }
            const outgoingRequests = deviceInfo
                ? await this.crypto.cryptoStore.getOutgoingRoomKeyRequestsByTarget(
                      event.getSender()!,
                      deviceInfo.deviceId,
                      [RoomKeyRequestState.Sent],
                  )
                : [];
            const weRequested = outgoingRequests.some(
                (req) =>
                    req.requestBody.room_id === content.room_id && req.requestBody.session_id === content.session_id,
            );
            const room = this.baseApis.getRoom(content.room_id);
            const memberEvent = room?.getMember(this.userId)?.events.member;
            const fromInviter =
                memberEvent?.getSender() === event.getSender() ||
                (memberEvent?.getUnsigned()?.prev_sender === event.getSender() &&
                    memberEvent?.getPrevContent()?.membership === "invite");
            const fromUs = event.getSender() === this.baseApis.getUserId();

            if (!weRequested && !fromUs) {
                // If someone sends us an unsolicited key and they're
                // not one of our other devices and it's not shared
                // history, ignore it
                if (!extraSessionData.sharedHistory) {
                    this.prefixedLogger.log("forwarded key not shared history - ignoring");
                    return;
                }

                // If someone sends us an unsolicited key for a room
                // we're already in, and they're not one of our other
                // devices or the one who invited us, ignore it
                if (room && !fromInviter) {
                    this.prefixedLogger.log("forwarded key not from inviter or from us - ignoring");
                    return;
                }
            }

            exportFormat = true;
            forwardingKeyChain = Array.isArray(content.forwarding_curve25519_key_chain)
                ? content.forwarding_curve25519_key_chain
                : [];

            // copy content before we modify it
            forwardingKeyChain = forwardingKeyChain.slice();
            forwardingKeyChain.push(senderKey);

            if (!content.sender_key) {
                this.prefixedLogger.error("forwarded_room_key event is missing sender_key field");
                return;
            }

            const ed25519Key = content.sender_claimed_ed25519_key;
            if (!ed25519Key) {
                this.prefixedLogger.error(`forwarded_room_key_event is missing sender_claimed_ed25519_key field`);
                return;
            }

            keysClaimed = {
                ed25519: ed25519Key,
            };

            // If this is a key for a room we're not in, don't load it
            // yet, just park it in case *this sender* invites us to
            // that room later
            if (!room) {
                const parkedData = {
                    senderId: event.getSender()!,
                    senderKey: content.sender_key,
                    sessionId: content.session_id,
                    sessionKey: content.session_key,
                    keysClaimed,
                    forwardingCurve25519KeyChain: forwardingKeyChain,
                };
                await this.crypto.cryptoStore.doTxn(
                    "readwrite",
                    ["parked_shared_history"],
                    (txn) => this.crypto.cryptoStore.addParkedSharedHistory(content.room_id!, parkedData, txn),
                    this.prefixedLogger.withPrefix("[addParkedSharedHistory]"),
                );
                return;
            }

            const sendingDevice =
                this.crypto.deviceList.getDeviceByIdentityKey(olmlib.OLM_ALGORITHM, senderKey) ?? undefined;
            const deviceTrust = this.crypto.checkDeviceInfoTrust(event.getSender()!, sendingDevice);

            if (fromUs && !deviceTrust.isVerified()) {
                return;
            }

            // forwarded keys are always untrusted
            extraSessionData.untrusted = true;

            // replace the sender key with the sender key of the session
            // creator for storage
            senderKey = content.sender_key;
        } else {
            keysClaimed = event.getKeysClaimed();
        }

        if (content["org.matrix.msc3061.shared_history"]) {
            extraSessionData.sharedHistory = true;
        }

        try {
            await this.olmDevice.addInboundGroupSession(
                content.room_id,
                senderKey,
                forwardingKeyChain,
                content.session_id,
                content.session_key,
                keysClaimed,
                exportFormat,
                extraSessionData,
            );

            // have another go at decrypting events sent with this session.
            if (await this.retryDecryption(senderKey, content.session_id, !extraSessionData.untrusted)) {
                // cancel any outstanding room key requests for this session.
                // Only do this if we managed to decrypt every message in the
                // session, because if we didn't, we leave the other key
                // requests in the hopes that someone sends us a key that
                // includes an earlier index.
                this.crypto.cancelRoomKeyRequest({
                    algorithm: content.algorithm,
                    room_id: content.room_id,
                    session_id: content.session_id,
                    sender_key: senderKey,
                });
            }

            // don't wait for the keys to be backed up for the server
            await this.crypto.backupManager.backupGroupSession(senderKey, content.session_id);
        } catch (e) {
            this.prefixedLogger.error(`Error handling m.room_key_event: ${e}`);
        }
    }

    /**
     * @param event - key event
     */
    public async onRoomKeyWithheldEvent(event: MatrixEvent): Promise<void> {
        const content = event.getContent();
        const senderKey = content.sender_key;

        if (content.code === "m.no_olm") {
            await this.onNoOlmWithheldEvent(event);
        } else if (content.code === "m.unavailable") {
            // this simply means that the other device didn't have the key, which isn't very useful information. Don't
            // record it in the storage
        } else {
            await this.olmDevice.addInboundGroupSessionWithheld(
                content.room_id,
                senderKey,
                content.session_id,
                content.code,
                content.reason,
            );
        }

        // Having recorded the problem, retry decryption on any affected messages.
        // It's unlikely we'll be able to decrypt sucessfully now, but this will
        // update the error message.
        //
        if (content.session_id) {
            await this.retryDecryption(senderKey, content.session_id);
        } else {
            // no_olm messages aren't specific to a given megolm session, so
            // we trigger retrying decryption for all the messages from the sender's
            // key, so that we can update the error message to indicate the olm
            // session problem.
            await this.retryDecryptionFromSender(senderKey);
        }
    }

    private async onNoOlmWithheldEvent(event: MatrixEvent): Promise<void> {
        const content = event.getContent();
        const senderKey = content.sender_key;
        const sender = event.getSender()!;
        this.prefixedLogger.warn(`${sender}:${senderKey} was unable to establish an olm session with us`);
        // if the sender says that they haven't been able to establish an olm
        // session, let's proactively establish one

        if (await this.olmDevice.getSessionIdForDevice(senderKey)) {
            // a session has already been established, so we don't need to
            // create a new one.
            this.prefixedLogger.debug("New session already created.  Not creating a new one.");
            await this.olmDevice.recordSessionProblem(senderKey, "no_olm", true);
            return;
        }
        let device = this.crypto.deviceList.getDeviceByIdentityKey(content.algorithm, senderKey);
        if (!device) {
            // if we don't know about the device, fetch the user's devices again
            // and retry before giving up
            await this.crypto.downloadKeys([sender], false);
            device = this.crypto.deviceList.getDeviceByIdentityKey(content.algorithm, senderKey);
            if (!device) {
                this.prefixedLogger.info(
                    "Couldn't find device for identity key " + senderKey + ": not establishing session",
                );
                await this.olmDevice.recordSessionProblem(senderKey, "no_olm", false);
                return;
            }
        }

        // XXX: switch this to use encryptAndSendToDevices() rather than duplicating it?

        await olmlib.ensureOlmSessionsForDevices(this.olmDevice, this.baseApis, { [sender]: [device] }, false);
        const encryptedContent: IEncryptedContent = {
            algorithm: olmlib.OLM_ALGORITHM,
            sender_key: this.olmDevice.deviceCurve25519Key!,
            ciphertext: {},
            [ToDeviceMessageId]: uuidv4(),
        };
        await olmlib.encryptMessageForDevice(
            encryptedContent.ciphertext,
            this.userId,
            undefined,
            this.olmDevice,
            sender,
            device,
            { type: "m.dummy" },
        );

        await this.olmDevice.recordSessionProblem(senderKey, "no_olm", true);

        await this.baseApis.sendToDevice("m.room.encrypted", {
            [sender]: {
                [device.deviceId]: encryptedContent,
            },
        });
    }

    public hasKeysForKeyRequest(keyRequest: IncomingRoomKeyRequest): Promise<boolean> {
        const body = keyRequest.requestBody;

        return this.olmDevice.hasInboundSessionKeys(
            body.room_id,
            body.sender_key,
            body.session_id,
            // TODO: ratchet index
        );
    }

    public shareKeysWithDevice(keyRequest: IncomingRoomKeyRequest): void {
        const userId = keyRequest.userId;
        const deviceId = keyRequest.deviceId;
        const deviceInfo = this.crypto.getStoredDevice(userId, deviceId)!;
        const body = keyRequest.requestBody;

        // XXX: switch this to use encryptAndSendToDevices()?

        this.olmlib
            .ensureOlmSessionsForDevices(this.olmDevice, this.baseApis, {
                [userId]: [deviceInfo],
            })
            .then((devicemap) => {
                const olmSessionResult = devicemap[userId][deviceId];
                if (!olmSessionResult.sessionId) {
                    // no session with this device, probably because there
                    // were no one-time keys.
                    //
                    // ensureOlmSessionsForUsers has already done the logging,
                    // so just skip it.
                    return null;
                }

                this.prefixedLogger.log(
                    "sharing keys for session " +
                        body.sender_key +
                        "|" +
                        body.session_id +
                        " with device " +
                        userId +
                        ":" +
                        deviceId,
                );

                return this.buildKeyForwardingMessage(body.room_id, body.sender_key, body.session_id);
            })
            .then((payload) => {
                const encryptedContent: IEncryptedContent = {
                    algorithm: olmlib.OLM_ALGORITHM,
                    sender_key: this.olmDevice.deviceCurve25519Key!,
                    ciphertext: {},
                    [ToDeviceMessageId]: uuidv4(),
                };

                return this.olmlib
                    .encryptMessageForDevice(
                        encryptedContent.ciphertext,
                        this.userId,
                        undefined,
                        this.olmDevice,
                        userId,
                        deviceInfo,
                        payload!,
                    )
                    .then(() => {
                        const contentMap = {
                            [userId]: {
                                [deviceId]: encryptedContent,
                            },
                        };

                        // TODO: retries
                        return this.baseApis.sendToDevice("m.room.encrypted", contentMap);
                    });
            });
    }

    private async buildKeyForwardingMessage(
        roomId: string,
        senderKey: string,
        sessionId: string,
    ): Promise<IKeyForwardingMessage> {
        const key = await this.olmDevice.getInboundGroupSessionKey(roomId, senderKey, sessionId);

        return {
            type: "m.forwarded_room_key",
            content: {
                "algorithm": olmlib.MEGOLM_ALGORITHM,
                "room_id": roomId,
                "sender_key": senderKey,
                "sender_claimed_ed25519_key": key!.sender_claimed_ed25519_key!,
                "session_id": sessionId,
                "session_key": key!.key,
                "chain_index": key!.chain_index,
                "forwarding_curve25519_key_chain": key!.forwarding_curve25519_key_chain,
                "org.matrix.msc3061.shared_history": key!.shared_history || false,
            },
        };
    }

    /**
     * @param untrusted - whether the key should be considered as untrusted
     * @param source - where the key came from
     */
    public importRoomKey(
        session: IMegolmSessionData,
        { untrusted, source }: { untrusted?: boolean; source?: string } = {},
    ): Promise<void> {
        const extraSessionData: OlmGroupSessionExtraData = {};
        if (untrusted || session.untrusted) {
            extraSessionData.untrusted = true;
        }
        if (session["org.matrix.msc3061.shared_history"]) {
            extraSessionData.sharedHistory = true;
        }
        return this.olmDevice
            .addInboundGroupSession(
                session.room_id,
                session.sender_key,
                session.forwarding_curve25519_key_chain,
                session.session_id,
                session.session_key,
                session.sender_claimed_keys,
                true,
                extraSessionData,
            )
            .then(() => {
                if (source !== "backup") {
                    // don't wait for it to complete
                    this.crypto.backupManager.backupGroupSession(session.sender_key, session.session_id).catch((e) => {
                        // This throws if the upload failed, but this is fine
                        // since it will have written it to the db and will retry.
                        this.prefixedLogger.log("Failed to back up megolm session", e);
                    });
                }
                // have another go at decrypting events sent with this session.
                this.retryDecryption(session.sender_key, session.session_id, !extraSessionData.untrusted);
            });
    }

    /**
     * Have another go at decrypting events after we receive a key. Resolves once
     * decryption has been re-attempted on all events.
     *
     * @internal
     * @param forceRedecryptIfUntrusted - whether messages that were already
     *     successfully decrypted using untrusted keys should be re-decrypted
     *
     * @returns whether all messages were successfully
     *     decrypted with trusted keys
     */
    private async retryDecryption(
        senderKey: string,
        sessionId: string,
        forceRedecryptIfUntrusted?: boolean,
    ): Promise<boolean> {
        const senderPendingEvents = this.pendingEvents.get(senderKey);
        if (!senderPendingEvents) {
            return true;
        }

        const pending = senderPendingEvents.get(sessionId);
        if (!pending) {
            return true;
        }

        const pendingList = [...pending];
        this.prefixedLogger.debug(
            "Retrying decryption on events:",
            pendingList.map((e) => `${e.getId()}`),
        );

        await Promise.all(
            pendingList.map(async (ev) => {
                try {
                    await ev.attemptDecryption(this.crypto, { isRetry: true, forceRedecryptIfUntrusted });
                } catch (e) {
                    // don't die if something goes wrong
                }
            }),
        );

        // If decrypted successfully with trusted keys, they'll have
        // been removed from pendingEvents
        return !this.pendingEvents.get(senderKey)?.has(sessionId);
    }

    public async retryDecryptionFromSender(senderKey: string): Promise<boolean> {
        const senderPendingEvents = this.pendingEvents.get(senderKey);
        if (!senderPendingEvents) {
            return true;
        }

        this.pendingEvents.delete(senderKey);

        await Promise.all(
            [...senderPendingEvents].map(async ([_sessionId, pending]) => {
                await Promise.all(
                    [...pending].map(async (ev) => {
                        try {
                            await ev.attemptDecryption(this.crypto);
                        } catch (e) {
                            // don't die if something goes wrong
                        }
                    }),
                );
            }),
        );

        return !this.pendingEvents.has(senderKey);
    }

    public async sendSharedHistoryInboundSessions(devicesByUser: Record<string, DeviceInfo[]>): Promise<void> {
        await olmlib.ensureOlmSessionsForDevices(this.olmDevice, this.baseApis, devicesByUser);

        const sharedHistorySessions = await this.olmDevice.getSharedHistoryInboundGroupSessions(this.roomId);
        this.prefixedLogger.log(
            `Sharing history in with users ${Object.keys(devicesByUser)}`,
            sharedHistorySessions.map(([senderKey, sessionId]) => `${senderKey}|${sessionId}`),
        );
        for (const [senderKey, sessionId] of sharedHistorySessions) {
            const payload = await this.buildKeyForwardingMessage(this.roomId, senderKey, sessionId);

            // FIXME: use encryptAndSendToDevices() rather than duplicating it here.
            const promises: Promise<unknown>[] = [];
            const contentMap: Record<string, Record<string, IEncryptedContent>> = {};
            for (const [userId, devices] of Object.entries(devicesByUser)) {
                contentMap[userId] = {};
                for (const deviceInfo of devices) {
                    const encryptedContent: IEncryptedContent = {
                        algorithm: olmlib.OLM_ALGORITHM,
                        sender_key: this.olmDevice.deviceCurve25519Key!,
                        ciphertext: {},
                        [ToDeviceMessageId]: uuidv4(),
                    };
                    contentMap[userId][deviceInfo.deviceId] = encryptedContent;
                    promises.push(
                        olmlib.encryptMessageForDevice(
                            encryptedContent.ciphertext,
                            this.userId,
                            undefined,
                            this.olmDevice,
                            userId,
                            deviceInfo,
                            payload,
                        ),
                    );
                }
            }
            await Promise.all(promises);

            // prune out any devices that encryptMessageForDevice could not encrypt for,
            // in which case it will have just not added anything to the ciphertext object.
            // There's no point sending messages to devices if we couldn't encrypt to them,
            // since that's effectively a blank message.
            for (const userId of Object.keys(contentMap)) {
                for (const deviceId of Object.keys(contentMap[userId])) {
                    if (Object.keys(contentMap[userId][deviceId].ciphertext).length === 0) {
                        this.prefixedLogger.log("No ciphertext for device " + userId + ":" + deviceId + ": pruning");
                        delete contentMap[userId][deviceId];
                    }
                }
                // No devices left for that user? Strip that too.
                if (Object.keys(contentMap[userId]).length === 0) {
                    this.prefixedLogger.log("Pruned all devices for user " + userId);
                    delete contentMap[userId];
                }
            }

            // Is there anything left?
            if (Object.keys(contentMap).length === 0) {
                this.prefixedLogger.log("No users left to send to: aborting");
                return;
            }

            await this.baseApis.sendToDevice("m.room.encrypted", contentMap);
        }
    }
}

const PROBLEM_DESCRIPTIONS = {
    no_olm: "The sender was unable to establish a secure channel.",
    unknown: "The secure channel with the sender was corrupted.",
};

registerAlgorithm(olmlib.MEGOLM_ALGORITHM, MegolmEncryption, MegolmDecryption);
