import type { Whop } from "@whop/sdk";

export type PaymentMode = "bank" | "card";
export const CARD_FEE_BASIS_POINTS = 270;

export function requestedPaymentMode(value: unknown): PaymentMode {
  if (value === undefined) return "bank";
  if (value === "bank" || value === "card") return value;
  throw new Error("Choose Wire or Card as your payment option.");
}

// Wires settle in USD; local-currency conversion would hide the wire method.
export function effectiveForceUsd(mode: PaymentMode, requested = false): boolean {
  return mode === "bank" || requested;
}

// Wire only: ACH (`us_bank_account`) is not offered and is disabled in both checkouts.
const bankMethods: Whop.PaymentMethodTypes[] = ["bank_wire"];
const cardMethods: Whop.PaymentMethodTypes[] = ["card"];
const otherMethods: Whop.PaymentMethodTypes[] = ["us_bank_account", "sepa_debit", "eu_bank_transfer", "crypto", "us_bank_transfer"];

export function paymentMethodsFor(mode: PaymentMode): Whop.PaymentMethodTypes[] {
  return mode === "card" ? [...cardMethods] : [...bankMethods];
}

export function paymentConfigurationFor(mode: PaymentMode) {
  return {
    enabled: paymentMethodsFor(mode),
    disabled: [...(mode === "card" ? bankMethods : cardMethods), ...otherMethods],
    // Whop offers only the explicit enabled list, subject to buyer eligibility.
    // No account/platform defaults or other bank methods may enter either flow.
    include_platform_defaults: false,
  };
}

// Compatibility exports for the unused legacy top-up helpers.
export const topUpPaymentMethods = paymentMethodsFor("bank");
export const topUpPaymentConfiguration = paymentConfigurationFor("bank");
