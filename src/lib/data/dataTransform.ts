export const DATA_TRANSFORMS = {
  LINEAR: "linear",
  LOG10: "log10",
} as const;

export type TDataTransform =
  (typeof DATA_TRANSFORMS)[keyof typeof DATA_TRANSFORMS];

export function applyDataTransform(
  value: number,
  transform: TDataTransform
): number {
  if (transform === DATA_TRANSFORMS.LOG10) {
    return Number.isFinite(value) && value > 0 ? Math.log10(value) : Number.NaN;
  }
  return value;
}

export function invertDataTransform(
  value: number,
  transform: TDataTransform
): number {
  if (transform === DATA_TRANSFORMS.LOG10) {
    return Number.isFinite(value) ? Math.pow(10, value) : Number.NaN;
  }
  return value;
}

export function getTransformedDataBounds(
  data: ArrayLike<number>,
  transform: TDataTransform
): { low: number; high: number } {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < data.length; index++) {
    const transformed = applyDataTransform(data[index], transform);
    if (!Number.isFinite(transformed)) {
      continue;
    }
    if (transformed < low) {
      low = transformed;
    }
    if (transformed > high) {
      high = transformed;
    }
  }

  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return { low: 0, high: 1 };
  }

  return { low, high };
}
