-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Key rotation review 0005 fixes.
-- key_ids: a fingerprint of the key behind each version after a rotation
--   (H1). A device checks its keys against it before writing, and before
--   taking keys from a link. scope 'space' is keyed by space id, 'user' by
--   user id. The fingerprint is a hash of the key with its label, scope,
--   owner and version: it reveals nothing about the key.
-- spaces.rotated_by/rotated_at: who made the latest rotation and when; only
--   they can send a key update link, and only for a while after (M4).
-- memberships.key_version: the newest space key version this member has
--   confirmed holding, so the rotator knows whether the partner still needs
--   a key update link (M3).
-- invites.key_version: the space key version a key update link carries (M4).
-- sessions.reauth_at: when this session last confirmed the person with a
--   passkey, for actions that need a recent sign-in (M4).
CREATE TABLE key_ids (
  scope TEXT NOT NULL CHECK (scope IN ('space', 'user')),
  owner TEXT NOT NULL,
  version INTEGER NOT NULL,
  kid TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (scope, owner, version)
);
ALTER TABLE spaces ADD COLUMN rotated_by TEXT;
ALTER TABLE spaces ADD COLUMN rotated_at INTEGER;
ALTER TABLE memberships ADD COLUMN key_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE invites ADD COLUMN key_version INTEGER;
ALTER TABLE sessions ADD COLUMN reauth_at INTEGER;
