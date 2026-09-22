// One application-host vocabulary for the UI bridge and native JS dispatcher.
// Chat directives remain owned exclusively by CHAT_BRIDGE_SPEC.
export const MOBILE_AUTH_MUTATIONS = Object.freeze(["unlock", "createAccount", "linkDevice", "changePassword", "resetPasswordWithMnemonic", "restoreWithMnemonic"]);
export const MOBILE_PROFILE_OPERATIONS = Object.freeze(["setProfileName", "setAvatarFileHash", "getAvatarFileHash", "setAvatarDataB64", "getAvatarDataB64"]);
export const MOBILE_VAULT_METHODS = Object.freeze(["status", "listAccounts", "getActiveIdentitySummary", "revealMnemonic", "lock", ...MOBILE_AUTH_MUTATIONS, ...MOBILE_PROFILE_OPERATIONS]);
