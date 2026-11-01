/**
 * Price parsing without floating point. "$0.001" with 6 decimals becomes "1000".
 */
export function usdToAtomic(price: string, decimals: number): string {
  const match = /^\$?\s*([0-9]+)(?:\.([0-9]+))?$/.exec(price.trim());
  if (!match) throw new Error(`Price "${price}" is not a dollar amount such as "$0.001".`);
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    throw new Error(`Price "${price}" has more than ${decimals} decimal places for this asset.`);
  }
  const atomic = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
  if (atomic <= 0n) throw new Error(`Price "${price}" must be greater than zero.`);
  return atomic.toString();
}

export function atomicToUsd(amount: string, decimals: number): string {
  const value = BigInt(amount);
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `$${whole}${fraction ? `.${fraction}` : ""}`;
}
