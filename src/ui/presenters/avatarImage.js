// Shared avatar image processing — single source of truth for turning a picked
// image File into the small JPEG we store/transmit. Used for both the user's
// own profile photo (ProfileSettingsView) and group photos (GroupDetailView).

export const MAX_AVATAR_SIZE = 256;
export const JPEG_QUALITY = 0.85;

// Center-crops the image to a square and resizes to MAX_AVATAR_SIZE, returning
// a JPEG data URL.
function resizeToJpegDataUrl(img) {
  const canvas = document.createElement("canvas");
  canvas.width = MAX_AVATAR_SIZE;
  canvas.height = MAX_AVATAR_SIZE;
  const ctx = canvas.getContext("2d");
  const srcSize = Math.min(img.naturalWidth, img.naturalHeight);
  const sx = (img.naturalWidth - srcSize) / 2;
  const sy = (img.naturalHeight - srcSize) / 2;
  ctx.drawImage(img, sx, sy, srcSize, srcSize, 0, 0, MAX_AVATAR_SIZE, MAX_AVATAR_SIZE);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

/**
 * Reads an image File, center-crops to a square, resizes to 256×256, and
 * resolves with the JPEG bytes as base64 (no `data:` prefix). Rejects if the
 * file cannot be read, decoded, or encoded.
 */
export function resizeImageFileToJpegB64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("avatar image read failed"));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error("avatar image decode failed"));
      img.onload = () => {
        const dataUrl = resizeToJpegDataUrl(img);
        const marker = ";base64,";
        const idx = dataUrl.indexOf(marker);
        if (idx < 0) {
          reject(new Error("avatar image encode failed"));
          return;
        }
        resolve(dataUrl.slice(idx + marker.length));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
