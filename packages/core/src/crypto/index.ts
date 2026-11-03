// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * The only module in Ours that touches keys or ciphertext.
 * See docs/adr/0003-crypto-library.md and docs/THREAT_MODEL.md.
 */
export { buildAad } from './aad';
export { KEY_LENGTH, NONCE_LENGTH, PAD_BLOCK, type Sealed } from './aead';
export {
  parseKeyRing,
  parseSpaceKeys,
  type SpaceKeyPayload,
  serializeKeyRing,
  serializeSpaceKeys,
} from './bundle';
export {
  CryptoError,
  type CryptoErrorCode,
  fromBase64Url,
  fromUtf8,
  randomBytes,
  toBase64Url,
  utf8,
} from './bytes';
export { type OpenResult, openDecodedRecord, scopeAllows, sealDecodedRecord } from './codec';
export {
  decryptRecord,
  encryptRecord,
  keyForHeader,
  openRecord,
  type RecordHeader,
  type Scope,
  sealRecord,
} from './envelope';
export {
  type EncryptedExport,
  EXPORT_FORMAT,
  isEncryptedExport,
  openExport,
  sealExport,
} from './export';
export { generateKey, KeyRing, type VersionedKey } from './keys';
export {
  CLOCK_SKEW_MS,
  DEFAULT_TTL_MS,
  MAX_LIFETIME_MS,
  NotificationBody,
  type NotificationInput,
  type NotifyTarget,
  type OpenedNotification,
  openNotification,
  sealNotification,
} from './notify';
export {
  type CreatedInvite,
  createDeviceInvite,
  createPartnerInvite,
  formatInviteFragment,
  INVITE_SECRET_LENGTH,
  type InviteKind,
  openDeviceInvite,
  openPartnerInvite,
  parseInviteFragment,
} from './pairing';
export {
  checkConfirmation,
  generateRecoveryPhrase,
  isValidPhrase,
  normalizePhrase,
  openBackup,
  PHRASE_WORDS,
  pickConfirmationIndices,
  recoveryKeyFromPhrase,
  resolveWord,
  sealBackup,
} from './recovery';
export { safetyCode } from './safety';
