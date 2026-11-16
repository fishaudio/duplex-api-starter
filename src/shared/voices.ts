// Voice Library counterparts of the Live 3 voices. These IDs are sent as voice.reference_id.
export const VOICE_PRESETS = [
  { id: "1c8ce946e6c847e6a3b32a88cce2a1e4", name: "Clara" },
  { id: "ea43bb2019214265a675f69fe4bcc14e", name: "Nora" },
  { id: "a47bfeff3bc1493cb92a04c8fe4eb762", name: "Owen" },
  { id: "b905eff67d954eb7bbe0754e6e62b3ea", name: "Marco" },
  { id: "f022291776c7474eb71403c454142ba6", name: "Milo" },
  { id: "c2bc3b0c9c7943f3a49e5b7cdb730792", name: "Jonah" },
  { id: "95df3b76803249da8b36795a55e9a535", name: "Harper" },
  { id: "c4e84d4cd97b4153bcd78560460f1c61", name: "Patricia" },
  { id: "90f9c20fa030430c85ddf3b6608ed1ad", name: "Maddie" },
  { id: "283c705d24334216964ff9ec67c6b987", name: "Ethan" },
  { id: "6b352181d9064977b3ec46de5cf01b39", name: "Tyler" },
  { id: "d50f7dccfb994c238f639be665dc325b", name: "Brianna" },
] as const;

export const DEFAULT_VOICE_REFERENCE_ID = VOICE_PRESETS[0].id;
