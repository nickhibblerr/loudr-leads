"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadWhop } from "@whop/elements";
import { Checkout, CheckoutElement, WhopElements } from "@whop/elements-react";
import { ArrowIcon, LockIcon } from "@/components/Icons";
import { formatAmount } from "@/lib/top-up";
import { MAX_LEAD_QUANTITY, MIN_LEAD_QUANTITY } from "@/lib/lead-pricing";
import { calculateCartQuote, cartMetadata, leadsForBudget, MAX_CART_STATES, type CartQuote } from "@/lib/lead-cart";
import { isValidLeadCount, type OrderMode } from "@/lib/leads";
import { clearSavedCart, readSavedCart, writeSavedCart } from "@/lib/saved-cart";
import LeadSelector from "@/components/LeadSelector";
import type { RateCard, RateState } from "@/lib/rate-card";
import type { LeadCheckoutItem } from "@/lib/lead-checkout";
import { CARD_FEE_LABEL, type PaymentMode } from "@/lib/payment-methods";

const appearance = {
  theme: { appearance: "dark" as const, accentColor: "yellow" as const, grayColor: "gray" as const },
};

/** One state in the order. `value` is a lead count, or whole dollars of lead spend in budget mode. */
type Line = { id: string; state: string; value: string; mode: OrderMode };
let lineSequence = 0;
const newLine = (state = "", value = "", mode: OrderMode = "leads"): Line => ({ id: `line-${++lineSequence}`, state, value, mode });

/** The lead count a line orders, or null when it can't be worked out yet. */
function leadCountFor(line: Line, rate: RateState | undefined): number | null {
  const entered = Number(line.value);
  if (!line.value.trim() || !Number.isSafeInteger(entered) || entered < 1) return null;
  if (line.mode === "leads") return entered;
  return rate?.price ? leadsForBudget(entered, rate.price)?.leadCount ?? null : null;
}

function amountError(line: Line, rate: RateState | undefined): string | null {
  const entered = Number(line.value);
  if (line.mode === "leads") {
    if (!line.value.trim()) return "Choose how many leads you’d like.";
    if (!isValidLeadCount(entered)) return "Enter a whole number of leads.";
    if (entered < MIN_LEAD_QUANTITY) return `The minimum order is ${MIN_LEAD_QUANTITY} leads per state.`;
    if (entered > MAX_LEAD_QUANTITY) return `Choose up to ${MAX_LEAD_QUANTITY.toLocaleString("en-US")} leads for this state.`;
    return null;
  }
  if (!line.value.trim()) return "Enter your lead budget.";
  if (!Number.isSafeInteger(entered) || entered < 1) return "Enter your budget in whole dollars.";
  if (!rate?.price) return null; // The state error explains what's missing.
  const count = leadCountFor(line, rate) ?? 0;
  if (count < MIN_LEAD_QUANTITY) return `The minimum is ${MIN_LEAD_QUANTITY} leads — ${formatAmount(MIN_LEAD_QUANTITY * rate.price)} for ${rate.name}.`;
  if (count > MAX_LEAD_QUANTITY) return `That budget covers more than ${MAX_LEAD_QUANTITY.toLocaleString("en-US")} leads. The most for ${rate.name} is ${formatAmount(MAX_LEAD_QUANTITY * rate.price)}.`;
  return null;
}

function stateErrorFor(line: Line, rate: RateState | undefined): string | null {
  if (!line.state || !rate) return "Choose a state to see your price.";
  if (rate.price === null) return `${rate.name} is sold out. Please choose another state or remove it.`;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

function sameCart(a: CartQuote, b: unknown): boolean {
  const other = b as CartQuote | null;
  return Boolean(other) && other!.currency === "usd" && other!.paymentMode === a.paymentMode &&
    other!.amountCents === a.amountCents && other!.feeCents === a.feeCents && other!.totalCents === a.totalCents &&
    other!.feeBasisPoints === a.feeBasisPoints && Array.isArray(other!.lines) && other!.lines.length === a.lines.length &&
    a.lines.every((line, index) => other!.lines[index]?.state === line.state && other!.lines[index]?.leadCount === line.leadCount &&
      other!.lines[index]?.unitPrice === line.unitPrice && other!.lines[index]?.amountCents === line.amountCents);
}

export default function TopUp() {
  const [rateCard, setRateCard] = useState<RateCard | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingRetry, setPricingRetry] = useState(0);
  const [lines, setLines] = useState<Line[]>(() => [newLine()]);
  const [activeId, setActiveId] = useState(() => lines[0].id);
  const [restored, setRestored] = useState(false);
  const [stateTouched, setStateTouched] = useState(false);
  const [touched, setTouched] = useState(false);
  const stateRef = useRef<HTMLSelectElement>(null);
  const currency = "usd" as const;
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("bank");
  const [forceUsd, setForceUsd] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(true);
  const [completed, setCompleted] = useState(false);
  const [elementError, setElementError] = useState<string | null>(null);
  const [checkoutVersion, setCheckoutVersion] = useState(0);
  const [step, setStep] = useState<"amount" | "payment">("amount");
  const [orderId, setOrderId] = useState("");
  const [checkoutItems, setCheckoutItems] = useState<LeadCheckoutItem[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const [loadError, setLoadError] = useState<{ retry: () => void } | null>(null);
  const [elements, setElements] = useState<ReturnType<typeof loadWhop> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const paymentTitleRef = useRef<HTMLHeadingElement>(null);

  const active = lines.find((line) => line.id === activeId) ?? lines[0];
  const rateFor = (code: string) => rateCard?.states.find((item) => item.code === code);
  const selectedState = rateFor(active.state);
  const value = active.value;
  const multiple = lines.length > 1;
  const stateError = rateCard && (stateTouched || (active.state && selectedState?.price === null)) ? stateErrorFor(active, selectedState) : null;
  const error = touched ? amountError(active, selectedState) : null;
  const usedStates = useMemo(() => new Set(lines.filter((line) => line.id !== active.id).map((line) => line.state)), [lines, active.id]);
  const lineValid = (line: Line) => !stateErrorFor(line, rateFor(line.state)) && !amountError(line, rateFor(line.state));
  const itemFor = (line: Line) => ({ state: line.state, quantity: leadCountFor(line, rateFor(line.state)) ?? 0 });
  const validItems = lines.filter(lineValid).map(itemFor);
  const itemsKey = JSON.stringify(validItems);
  const bankQuote = useMemo(() => {
    try { return rateCard && validItems.length ? calculateCartQuote(validItems, rateCard.states, "bank") : null; }
    catch { return null; }
  }, [itemsKey, rateCard]);
  const cardQuote = useMemo(() => {
    try { return rateCard && validItems.length ? calculateCartQuote(validItems, rateCard.states, "card") : null; }
    catch { return null; }
  }, [itemsKey, rateCard]);
  const quote = paymentMode === "card" ? cardQuote : bankQuote;
  const checkoutMetadata = useMemo(() => quote ? { ...cartMetadata(quote, forceUsd), order_id: orderId } : undefined, [quote, forceUsd, orderId]);
  const accountId = process.env.NEXT_PUBLIC_WHOP_ACCOUNT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const configured = Boolean(accountId?.startsWith("biz_") && siteUrl);
  const canAddState = lines.length < MAX_CART_STATES && (!rateCard || rateCard.states.some((item) => item.price !== null && !lines.some((line) => line.state === item.code)));

  // Restore the buyer's last order from this browser, then keep it saved as they edit.
  useEffect(() => {
    const saved = readSavedCart();
    if (saved.length) {
      const restoredLines = saved.map((line) => newLine(line.state, line.value, line.mode));
      setLines(restoredLines);
      setActiveId(restoredLines[0].id);
    }
    setRestored(true);
  }, []);
  useEffect(() => {
    if (restored && !completed) writeSavedCart(lines.map((line) => ({ state: line.state, value: line.value, mode: line.mode })));
  }, [lines, restored, completed]);

  // Load the hosted SDK while the buyer chooses an amount, rather than after Continue.
  useEffect(() => {
    if (configured) setElements(loadWhop());
  }, [configured]);

  useEffect(() => {
    if (step !== "amount") return;
    const controller = new AbortController();
    let busy = false;
    async function refresh() {
      if (busy || preparingRef.current || document.visibilityState === "hidden") return;
      busy = true;
      try {
        const response = await fetch("/api/prices", { cache: "no-store", signal: controller.signal });
        const next: RateCard = await response.json();
        if (!response.ok || !Array.isArray(next.states) || typeof next.version !== "string") throw new Error("Unable to load current prices. Please retry.");
        if (!controller.signal.aborted && !preparingRef.current) { setRateCard(next); setPricingError(null); }
      } catch (error) {
        if (!controller.signal.aborted) setPricingError(errorMessage(error));
      } finally { busy = false; }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [step, pricingRetry]);

  useEffect(() => {
    if (step === "payment") paymentTitleRef.current?.focus();
  }, [step]);

  function updateActive(change: Partial<Line>) {
    setLines((current) => current.map((line) => line.id === active.id ? { ...line, ...change } : line));
    setCheckoutError(null);
  }

  // Switching between leads and budget keeps the same order where it can.
  function changeMode(mode: OrderMode) {
    const rate = selectedState;
    const count = leadCountFor(active, rate);
    let value = "";
    if (mode === "budget" && count && rate?.price) value = String(Math.ceil(count * rate.price));
    if (mode === "leads" && count) value = String(count);
    updateActive({ mode, value });
    setTouched(Boolean(value));
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function activate(id: string, focus: "state" | "amount" = "amount") {
    if (preparing) return;
    setActiveId(id);
    setStateTouched(false);
    setTouched(false);
    requestAnimationFrame(() => (focus === "state" ? stateRef.current : inputRef.current)?.focus());
  }

  function addState() {
    if (preparing || !canAddState) return;
    // Finish the state being edited first, so the order never collects blank rows.
    if (!lineValid(active)) {
      setStateTouched(true);
      setTouched(true);
      (stateErrorFor(active, selectedState) ? stateRef.current : inputRef.current)?.focus();
      return;
    }
    const line = newLine("", "", active.mode);
    setLines((current) => [...current, line]);
    setCheckoutError(null);
    activate(line.id, "state");
  }

  function removeLine(id: string) {
    if (preparing) return;
    const index = lines.findIndex((line) => line.id === id);
    const remaining = lines.filter((line) => line.id !== id);
    if (!remaining.length) return;
    setLines(remaining);
    setCheckoutError(null);
    if (id === active.id) activate(remaining[Math.max(0, index - 1)].id);
  }

  async function preparePlan(cart: CartQuote, nextForceUsd = false) {
    const result = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items: cart.lines.map((line) => ({ state: line.state, quantity: line.leadCount })),
        paymentMode: cart.paymentMode, forceUsd: nextForceUsd, priceVersion: rateCard?.version }),
      signal: AbortSignal.timeout(20_000),
    });
    const response = await result.json();
    if (result.status === 409 && response.rateCard) {
      setRateCard(response.rateCard);
      setPlanId(null);
      setStep("amount");
      throw new Error(response.error || "Prices changed. Review the new total and continue again.");
    }
    if (!result.ok || typeof response.planId !== "string" || !/^plan_[a-zA-Z0-9]+$/.test(response.planId) ||
      !sameCart(cart, response.cart) || response.forceUsd !== nextForceUsd) {
      throw new Error(response.error || "We couldn’t load payment options. Please try again.");
    }
    const items = response.items as LeadCheckoutItem[];
    const feeItems = cart.feeCents > 0 ? 1 : 0;
    if (!Array.isArray(items) || items.length !== cart.lines.length + feeItems || items[0]?.plan !== response.planId ||
      cart.lines.some((line, index) => items[index]?.quantity !== line.leadCount) ||
      (feeItems && (items[cart.lines.length]?.plan !== response.feePlanId || items[cart.lines.length]?.quantity !== 1)) ||
      new Set(items.map((item) => item.plan)).size !== items.length ||
      items.some((item) => typeof item.plan !== "string" || !/^plan_[a-zA-Z0-9]+$/.test(item.plan))) {
      throw new Error("We couldn’t confirm the items in your order. Please try again.");
    }
    setCheckoutItems(items);
    return response.planId as string;
  }

  async function continueToPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (preparingRef.current) return;
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const nextMode: PaymentMode = submitter instanceof HTMLButtonElement && submitter.value === "card" ? "card" : "bank";
    // A state added but never filled in is dropped rather than blocking checkout.
    const filled = lines.filter((line) => line.state || line.value.trim());
    const kept = filled.length ? filled : lines.slice(0, 1);
    if (kept.length !== lines.length) setLines(kept);
    const invalid = kept.find((line) => !lineValid(line));
    if (invalid) {
      setActiveId(invalid.id);
      setStateTouched(true);
      setTouched(true);
      const focusState = Boolean(stateErrorFor(invalid, rateFor(invalid.state)));
      requestAnimationFrame(() => (focusState ? stateRef.current : inputRef.current)?.focus());
      return;
    }
    if (!rateCard || pricingError) { inputRef.current?.focus(); return; }
    let nextQuote: CartQuote;
    try { nextQuote = calculateCartQuote(kept.map(itemFor), rateCard.states, nextMode); }
    catch (cause) { setCheckoutError(errorMessage(cause)); return; }
    preparingRef.current = true;
    setPaymentMode(nextMode);
    setPreparing(true);
    setCheckoutError(null);
    try {
      if (!configured) {
        const response = await fetch("/api/prices", { cache: "no-store" });
        const current: RateCard = await response.json();
        if (!response.ok) throw new Error("Unable to check current prices. Please retry.");
        if (current.version !== rateCard.version) {
          setRateCard(current);
          throw new Error("Prices have changed. Review the updated total and continue again.");
        }
      }
      if (configured) {
        setPlanId(await preparePlan(nextQuote, nextMode === "bank"));
        setElementError(null);
        setCheckoutLoading(true);
        setCompleted(false);
      }
      setForceUsd(nextMode === "bank");
      setOrderId(`leads_${Date.now().toString(36)}`);
      setStep("payment");
    } catch (error) {
      setCheckoutError(errorMessage(error));
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  function changeAmount() {
    if (preparing || completed) return;
    setPlanId(null);
    setPaymentMode("bank");
    setForceUsd(false);
    setCheckoutError(null);
    setStep("amount");
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function makeUsd() {
    if (!quote || forceUsd || preparingRef.current || completed) return;
    preparingRef.current = true;
    setPreparing(true);
    setCheckoutError(null);
    try {
      const usdPlan = await preparePlan(quote, true);
      setPlanId(usdPlan);
      setForceUsd(true);
      setElementError(null);
      setCheckoutLoading(true);
    } catch (error) {
      setCheckoutError(errorMessage(error));
    } finally {
      preparingRef.current = false;
      setPreparing(false);
    }
  }

  const leadsLabel = (count: number) => `${count.toLocaleString("en-US")} ${count === 1 ? "lead" : "leads"}`;

  return (
    <WhopElements elements={elements} appearance={appearance} onLoadError={(_error, retry) => setLoadError({ retry })}>
    <div className="checkout-wrap">
      <div className="checkout-panel">
        <div className="panel-topline">
          <span className="panel-caption">Your growth, on your terms</span>
          <span className="step-counter">{step === "amount" ? "01" : "02"}<span> / 02</span></span>
        </div>
        {step === "amount" ? (
          <form onSubmit={continueToPayment} noValidate aria-busy={preparing}>
            <h2 className="panel-title">Make room for more.</h2>
            <p className="panel-description">{multiple ? "Set the leads for each state in your order." : "Choose your state and how many leads you’d like."}</p>

            {!rateCard && !pricingError && <p role="status" className="panel-footnote">Loading current prices…</p>}
            {pricingError && <div role="alert"><p className="form-error">{pricingError}</p><button type="button" className="text-button" onClick={() => setPricingRetry((n) => n + 1)}>Retry prices</button></div>}

            {multiple && (
              <div className="cart-block">
                <p className="cart-heading" id="cart-heading">Your order <span>{lines.length} states</span></p>
                <ul className="cart-lines" aria-labelledby="cart-heading">
                  {lines.map((line) => {
                    const rate = rateFor(line.state);
                    const count = leadCountFor(line, rate) ?? 0;
                    const valid = lineValid(line);
                    const isActive = line.id === active.id;
                    return (
                      <li key={line.id} className={`cart-line${isActive ? " active" : ""}${!valid && !isActive ? " incomplete" : ""}`}>
                        <button type="button" className="cart-line-main" onClick={() => activate(line.id)} aria-current={isActive ? "true" : undefined} disabled={preparing}>
                          <span className="cart-line-state">{rate ? <>{rate.name} <span>{rate.code}</span></> : "New state"}</span>
                          <span className="cart-line-meta">
                            {valid && rate?.price ? <>{leadsLabel(count)} · {formatAmount(rate.price * count)}</> : rate?.price === null ? "Sold out" : isActive ? "Editing" : "Needs details"}
                          </span>
                        </button>
                        <button type="button" className="cart-line-remove" onClick={() => removeLine(line.id)} disabled={preparing}
                          aria-label={`Remove ${rate?.name ?? "this state"} from your order`}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}

            <label className="state-label" htmlFor="lead-state">{multiple ? `State ${lines.findIndex((line) => line.id === active.id) + 1} of ${lines.length}` : "Your state"}</label>
            <select id="lead-state" className="state-field" ref={stateRef} value={active.state} disabled={preparing || !rateCard}
              onChange={(event) => { updateActive({ state: event.target.value }); setStateTouched(true); }}
              onBlur={() => setStateTouched(true)} aria-invalid={Boolean(stateError)}
              aria-describedby={stateError ? "state-error" : undefined}>
              <option value="" disabled>Select your state</option>
              {rateCard?.states.map((item) => <option key={item.code} value={item.code} disabled={item.price === null || usedStates.has(item.code)}>
                {item.name} ({item.code}) — {item.price === null ? "Sold out" : usedStates.has(item.code) ? "In your order" : `${formatAmount(item.price)} / lead`}
              </option>)}
            </select>
            {stateError && <p id="state-error" className="form-error" role="alert">{stateError}</p>}
            <LeadSelector mode={active.mode} onModeChange={changeMode} value={value} onChange={(next) => { updateActive({ value: next }); setTouched(true); }}
              onBlur={() => setTouched(true)} error={error} disabled={preparing} unitPrice={selectedState?.price ?? null} inputRef={inputRef} />

            <button type="button" className="add-state-button" onClick={addState} disabled={preparing || !canAddState || !rateCard}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
              {canAddState ? "Add another state" : lines.length >= MAX_CART_STATES ? `Up to ${MAX_CART_STATES} states per order` : "Every available state is in your order"}
            </button>

            <div className="quote-summary" aria-live="polite">
              {multiple ? (bankQuote?.lines ?? []).map((line) => (
                <div key={line.state}><span>{line.stateName} · {line.leadCount.toLocaleString("en-US")} × {formatAmount(line.unitPrice)}</span><span>{formatAmount(line.amount, currency)}</span></div>
              )) : (
                <div><span>Price per lead{selectedState ? ` (${selectedState.code})` : ""}</span><span>{selectedState?.price ? formatAmount(selectedState.price) : "—"}</span></div>
              )}
              <div className={multiple ? "cart-subtotal" : undefined}><span>Lead subtotal{bankQuote ? ` (${leadsLabel(bankQuote.leadCount)})` : ""}</span><span>{bankQuote ? formatAmount(bankQuote.amount, currency) : "—"}</span></div>
            </div>
            {checkoutError && <p className="form-error checkout-error" role="alert">{checkoutError}</p>}
            <div className="payment-options" role="group" aria-label="Choose your payment method">
              <div className="payment-option">
                <div className="payment-option-total" id="bank-total" aria-live="polite"><span>Wire total</span><strong>{bankQuote ? formatAmount(bankQuote.total, currency) : "—"}</strong></div>
                <p className="payment-option-note">No additional fee</p>
                <button className="primary-button payment-option-button" type="submit" name="paymentMode" value="bank" aria-describedby="bank-total" disabled={preparing || !bankQuote || Boolean(pricingError)}>
                  <span>{preparing && paymentMode === "bank" ? "Loading Wire…" : "Continue to Payment (Wire)"}</span><ArrowIcon />
                </button>
              </div>
              <div className="payment-option payment-option-card">
                <div className="payment-option-fee" id="card-fee" aria-live="polite"><span>Card fee ({CARD_FEE_LABEL})</span><span>{cardQuote ? `+${formatAmount(cardQuote.fee, currency)}` : "—"}</span></div>
                <div className="payment-option-total" id="card-total" aria-live="polite"><span>Card total</span><strong>{cardQuote ? formatAmount(cardQuote.total, currency) : "—"}</strong></div>
                <button className="primary-button payment-option-button card-payment-button" type="submit" name="paymentMode" value="card" aria-describedby="card-fee card-total" disabled={preparing || !cardQuote || Boolean(pricingError)}>
                  <span>{preparing && paymentMode === "card" ? "Loading Card…" : "Continue to Payment (Card)"}</span><ArrowIcon />
                </button>
              </div>
            </div>
            <p className="panel-footnote">Totals shown in USD. Card payments include the {CARD_FEE_LABEL} card fee shown above.{multiple ? " Your order is saved on this device." : ""}</p>
          </form>
        ) : (
          <>
            <h2 className="panel-title" ref={paymentTitleRef} tabIndex={-1}>One step from momentum.</h2>
            <p className="panel-description">{paymentMode === "card" ? "Pay by card securely with Whop." : "Pay by wire transfer securely with Whop."}</p>
            <div className="payment-summary">
              {(quote?.lines ?? []).map((line) => (
                <div key={line.state}><span>{line.stateName} · {leadsLabel(line.leadCount)}</span><span>{formatAmount(line.amount, currency)}</span></div>
              ))}
              {paymentMode === "card" && <div className="fee-summary-row"><span>Card fee ({CARD_FEE_LABEL})</span><span>{quote ? formatAmount(quote.fee, currency) : "—"}</span></div>}
              <div className="quote-total"><span>USD total{quote && quote.lines.length > 1 ? ` · ${leadsLabel(quote.leadCount)}` : ""}</span><strong>{quote ? formatAmount(quote.total, currency) : "—"}</strong></div>
              <button className="text-button" type="button" onClick={changeAmount} disabled={preparing || completed}>Change states, leads or payment method</button>
            </div>
            {configured && planId && quote ? (
              <>
                {loadError && (
                  <div className="payment-load-error" role="alert">
                    <p className="form-error">We couldn’t load the secure payment form. Check your connection and try again.</p>
                    <button className="text-button" type="button" onClick={() => { loadError.retry(); setLoadError(null); }}>Reload payment form</button>
                  </div>
                )}
                <p className="currency-note">{paymentMode === "bank" ? "Wire payments are charged in USD." : forceUsd ? "Payment currency is USD." : "Your card checkout and local-currency total appear below."}</p>
                {elementError && <div className="payment-load-error" role="alert">
                  <p className="form-error">{elementError}</p>
                  <button className="text-button" type="button" onClick={() => { setElementError(null); setCheckoutLoading(true); setCheckoutVersion((version) => version + 1); }}>Reload checkout</button>
                </div>}
                <Checkout key={`${JSON.stringify(checkoutItems)}:${checkoutVersion}`} items={checkoutItems}
                  metadata={checkoutMetadata}
                  returnUrl={`${siteUrl}/checkout/return?order=${orderId}`}
                  onLoadingChange={setCheckoutLoading}
                  onComplete={() => { setCompleted(true); clearSavedCart(); }}>
                  <CheckoutElement fallback={<div className="checkout-loading" role="status">Loading secure checkout…</div>}
                    onReady={() => setCheckoutLoading(false)}
                    onError={(event) => { setElementError(event.message || "Unable to load checkout. Please try again."); setCheckoutLoading(false); }} />
                </Checkout>
                {checkoutError && <p className="form-error" role="alert">{checkoutError}</p>}
                {paymentMode === "card" && <div className="usd-override">
                  {forceUsd ? <p role="status">Paying in US dollars.</p> : <>
                    <p>Prefer to pay in US dollars?</p>
                    <button className="text-button" type="button" onClick={makeUsd} disabled={preparing || checkoutLoading || completed}>{preparing ? "Switching to USD…" : "Make USD"}</button>
                  </>}
                </div>}
              </>
            ) : (
              <div className="configuration-notice" role="status">
                <LockIcon />
                <h3>Payments are being connected.</h3>
                <p>Please check back shortly to complete your lead order.</p>
              </div>
            )}
          </>
        )}
      </div>
    </div>
    </WhopElements>
  );
}
