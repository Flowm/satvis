// Committed on purpose: ion restricts it to satvis.space, so localhost and `deploy:preview`
// need an unrestricted VITE_CESIUM_ION_TOKEN in .env.development. Set globally as
// `Ion.defaultAccessToken` because `createGooglePhotorealistic3DTileset` takes no token.
const SATVIS_SPACE_TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI3ZmFkM2NiZC04NGJlLTRlOTYtOWNkYi1mZDA0ZjQwNWFjNDIiLCJpZCI6MjgzLCJzdWIiOiJGbG93bSIsImlzcyI6Imh0dHBzOi8vYXBpLmNlc2l1bS5jb20iLCJhdWQiOiJzYXR2aXMuc3BhY2UiLCJpYXQiOjE3ODUyODU4NTF9.L7ogGw5aWyv4jFApMbLVRiuPZrTIAQ5lE-cr4bC2sNc";

export const ionAccessToken: string = import.meta.env.VITE_CESIUM_ION_TOKEN || SATVIS_SPACE_TOKEN;
