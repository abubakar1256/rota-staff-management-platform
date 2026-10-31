export const PASSPORT_RATIO = 7 / 9;
const clamp = (value, min, max) => Math.min(max, Math.max(min, Number(value) || 0));

export function rotatedPhotoSize(width, height, rotation = 0) {
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) throw new Error("The photo has invalid dimensions.");
  const angle = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return { width: angle % 180 ? height : width, height: angle % 180 ? width : height, rotation: angle };
}

export function passportCropRect(width, height, { zoom = 1, position = { x: 0, y: 0 } } = {}) {
  const size = rotatedPhotoSize(width, height);
  const cropWidth = Math.min(size.width, size.height * PASSPORT_RATIO) / clamp(zoom, 1, 4);
  const cropHeight = cropWidth / PASSPORT_RATIO;
  return {
    x: (size.width - cropWidth) * (clamp(position.x, -1, 1) + 1) / 2,
    y: (size.height - cropHeight) * (clamp(position.y, -1, 1) + 1) / 2,
    width: cropWidth, height: cropHeight,
  };
}

export function panPassportCrop(width, height, settings, dx, dy, frameWidth, frameHeight) {
  if (!(frameWidth > 0 && frameHeight > 0)) return settings.position;
  const size = rotatedPhotoSize(width, height, settings.rotation);
  const crop = passportCropRect(size.width, size.height, settings);
  const move = (position, delta, cropSize, sourceSize, frameSize) => sourceSize - cropSize > .000001
    ? clamp(position - 2 * delta * cropSize / frameSize / (sourceSize - cropSize), -1, 1) : 0;
  return {
    x: move(settings.position.x, dx, crop.width, size.width, frameWidth),
    y: move(settings.position.y, dy, crop.height, size.height, frameHeight),
  };
}

export function drawPassportCrop(canvas, image, settings, outputWidth = 700) {
  const size = rotatedPhotoSize(image.naturalWidth, image.naturalHeight, settings.rotation);
  const crop = passportCropRect(size.width, size.height, settings);
  canvas.width = outputWidth;
  canvas.height = Math.round(outputWidth / PASSPORT_RATIO);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Your browser could not prepare the photo. Please try another browser.");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.setTransform(canvas.width / crop.width, 0, 0, canvas.height / crop.height,
    -crop.x * canvas.width / crop.width, -crop.y * canvas.height / crop.height);
  if (size.rotation === 90) ctx.translate(image.naturalHeight, 0);
  if (size.rotation === 180) ctx.translate(image.naturalWidth, image.naturalHeight);
  if (size.rotation === 270) ctx.translate(0, image.naturalWidth);
  ctx.rotate(size.rotation * Math.PI / 180);
  ctx.drawImage(image, 0, 0);
  return crop;
}
