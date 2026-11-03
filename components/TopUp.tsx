"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { loadWhop } from "@whop/elements";
import { Checkout, CheckoutElement, WhopElements } from "@whop/elements-react";
import { ArrowIcon, LockIcon } from "@/components/Icons";
import { formatAmount } from "@/lib/top-up";
import { calculateLeadQuote, MAX_LEAD_QUANTITY, leadMetadata, type LeadQuote } from "@/lib/lead-pricing";
import { isValidLeadCount } from "@/lib/leads";
import LeadSelector from "@/components/LeadSelector";
import type { RateCard } from "@/lib/rate-card";
import type { LeadCheckoutItem } from "@/lib/lead-checkout";
import type { PaymentMode } from "@/lib/payment-methods";

const appearance = {
  theme: { appearance: "dark" as const, accentColor: "yellow" as const, grayColor: "gray" as const },
};

function amountError(value: string, max: number): string | null {
  if (!value.trim()) return "Choose how many leads you’d like.";
  if (!isValidLeadCount(Number(value))) return "Enter a whole number of leads, starting at 1.";
  if (Number(value) > max) return `Choose up to ${max.toLocaleString("en-US")} leads for this state.`;
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

export default function TopUp() {
  const [rateCard, setRateCard] = useState<RateCard | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [pricingRetry, setPricingRetry] = useState(0);
  const [value, setValue] = useState("");
  const [state, setState] = useState("");
  const [stateTouched, setStateTouched] = useState(false);
  const stateRef = useRef<HTMLSelectElement>(null);
  const currency = "usd" as const;
  const [paymentMode, setPaymentMode] = useState<PaymentMode>("bank");
  const [forceUsd, setForceUsd] = useState(false);
  const [checkoutLoading, setCheckoutLoading] = useState(true);
  const [completed, setCompleted] = useState(false);
  const [elementError, setElementError] = useState<string | null>(null);
  const [checkoutVersion, setCheckoutVersion] = useState(0);
  const [step, setStep] = useState<"amount" | "payment">("amount");
  const [touched, setTouched] = useState(false);
  const [orderId, setOrderId] = useState("");
  const [checkoutItems, setCheckoutItems] = useState<LeadCheckoutItem[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [checkoutError, setCheckoutError] = useState<string | null>(null);
  const preparingRef = useRef(false);
  const [loadError, setLoadError] = useState<{ retry: () => void } | null>(null);
  const [elements, setElements] = useState<ReturnType<typeof loadWhop> | null>(null);
  async function preparePlan(quote: LeadQuote, forceUsd = false) {
    const result = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: quote.state, quantity: quote.leadCount, paymentMode: quote.paymentMode, forceUsd, priceVersion: rateCard?.version }),
      signal: AbortSignal.timeout(15_000),
    });
    const response = await result.json();
    if (result.status === 409 && response.rateCard) {
      setRateCard(response.rateCard);
      setPlanId(null);
      setStep("amount");
      throw new Error(response.error || "Prices changed. Review the new total and continue again.");
    }
    if (!result.ok || typeof response.planId !== "string" || !/^plan_[a-zA-Z0-9]+$/.test(response.planId) ||
      response.quote?.state !== quote.state || response.quote?.leadCount !== quote.leadCount || response.quote?.unitPrice !== quote.unitPrice ||
      response.quote?.totalCents !== quote.totalCents || response.quote?.amountCents !== quote.amountCents ||
      response.quote?.paymentMode !== quote.paymentMode || response.quote?.feeCents !== quote.feeCents ||
      response.quote?.feeBasisPoints !== quote.feeBasisPoints || response.quote?.feePercent !== quote.feePercent ||
      response.quote?.currency !== "usd" || response.forceUsd !== forceUsd) {
      throw new Error(response.error || "We couldn’t load payment options. Please try again.");
    }
    const items = response.items as LeadCheckoutItem[];
    if (!Array.isArray(items) || items.length !== (quote.feeCents > 0 ? 2 : 1) ||
      items[0]?.plan !== response.planId || items[0]?.quantity !== quote.leadCount ||
      (quote.feeCents > 0 && (items[1]?.plan !== response.feePlanId || items[1]?.quantity !== 1)) ||
      items.some((item) => typeof item.plan !== "string" || !/^plan_[a-zA-Z0-9]+$/.test(item.plan))) {
      throw new Error("We couldn’t confirm the items in your order. Please try again.");
    }
    setCheckoutItems(items);
    return response.planId as string;
  }
  const inputRef = useRef<HTMLInputElement>(null);
  const paymentTitleRef = useRef<HTMLHeadingElement>(null);
  const leadCount = Number(value);
  const selectedState = rateCard?.states.find((item) => item.code === state);
  const maxLeads = MAX_LEAD_QUANTITY;
  const stateError = stateTouched && !selectedState ? "Choose a state to see your price." : selectedState?.price === null ? `${selectedState.name} is sold out. Please choose another state.` : null;
  const bankQuote = useMemo(() => {
    try { return rateCard ? calculateLeadQuote(state, leadCount, rateCard.states, "bank") : null; }
    catch { return null; }
  }, [state, leadCount, rateCard]);
  const cardQuote = useMemo(() => {
    try { return rateCard ? calculateLeadQuote(state, leadCount, rateCard.states, "card") : null; }
    catch { return null; }
  }, [state, leadCount, rateCard]);
  const quote = paymentMode === "card" ? cardQuote : bankQuote;
  const checkoutMetadata = useMemo(() => quote ? { ...leadMetadata(quote, forceUsd), order_id: orderId } : undefined, [quote, forceUsd, orderId]);
  const error = (touched ? amountError(value, maxLeads) : null);
  const accountId = process.env.NEXT_PUBLIC_WHOP_ACCOUNT_ID;
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  const configured = Boolean(accountId?.startsWith("biz_") && siteUrl);

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

  async function continueToPayment(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submitter = (event.nativeEvent as SubmitEvent).submitter;
    const nextMode: PaymentMode = submitter instanceof HTMLButtonElement && submitter.value === "card" ? "card" : "bank";
    const nextQuote = nextMode === "card" ? cardQuote : bankQuote;
    setTouched(true);
    setStateTouched(true);
    if (!selectedState || selectedState.price === null) { stateRef.current?.focus(); return; }
    if (amountError(value, maxLeads)) {
      inputRef.current?.focus();
      return;
    }
    if (!nextQuote || !rateCard || pricingError) { inputRef.current?.focus(); return; }
    if (preparingRef.current) return;
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
            <p className="panel-description">Choose your state and how many leads you’d like.</p>

            {!rateCard && !pricingError && <p role="status" className="panel-footnote">Loading current prices…</p>}
            {pricingError && <div role="alert"><p className="form-error">{pricingError}</p><button type="button" className="text-button" onClick={() => setPricingRetry((n) => n + 1)}>Retry prices</button></div>}
            <label className="state-label" htmlFor="lead-state">Your state</label>
            <select id="lead-state" className="state-field" ref={stateRef} value={state} disabled={preparing || !rateCard}
              onChange={(event) => { setState(event.target.value); setStateTouched(true); setCheckoutError(null); }}
              onBlur={() => setStateTouched(true)} aria-invalid={Boolean(stateError)}
              aria-describedby={stateError ? "state-error" : undefined}>
              <option value="" disabled>Select your state</option>
              {rateCard?.states.map((item) => <option key={item.code} value={item.code} disabled={item.price === null}>
                {item.name} ({item.code}) — {item.price === null ? "Sold out" : `${formatAmount(item.price)} / lead`}
              </option>)}
            </select>
            {stateError && <p id="state-error" className="form-error" role="alert">{stateError}</p>}
            <LeadSelector value={value} onChange={(next) => { setValue(next); setTouched(true); setCheckoutError(null); }}
              onBlur={() => setTouched(true)} error={error} disabled={preparing} max={maxLeads} inputRef={inputRef} />

            <div className="quote-summary" aria-live="polite">
              <div><span>Price per lead{selectedState ? ` (${selectedState.code})` : ""}</span><span>{selectedState?.price ? formatAmount(selectedState.price) : "—"}</span></div>
              <div><span>Lead subtotal{bankQuote ? ` (${bankQuote.leadCount} ${bankQuote.leadCount === 1 ? "lead" : "leads"})` : ""}</span><span>{bankQuote ? formatAmount(bankQuote.amount, currency) : "—"}</span></div>
            </div>
            {checkoutError && <p className="form-error checkout-error" role="alert">{checkoutError}</p>}
            <div className="payment-options" role="group" aria-label="Choose your payment method">
              <div className="payment-option">
                <div className="payment-option-total" id="bank-total" aria-live="polite"><span>Wire &amp; ACH total</span><strong>{bankQuote ? formatAmount(bankQuote.total, currency) : "—"}</strong></div>
                <p className="payment-option-note">No additional fee</p>
                <button className="primary-button payment-option-button" type="submit" name="paymentMode" value="bank" aria-describedby="bank-total" disabled={preparing || !bankQuote || Boolean(pricingError)}>
                  <span>{preparing && paymentMode === "bank" ? "Loading Wire & ACH…" : "Continue to Payment (Wire & ACH)"}</span><ArrowIcon />
                </button>
              </div>
              <div className="payment-option payment-option-card">
                <div className="payment-option-fee" id="card-fee" aria-live="polite"><span>Card fee (2.7%)</span><span>{cardQuote ? `+${formatAmount(cardQuote.fee, currency)}` : "—"}</span></div>
                <div className="payment-option-total" id="card-total" aria-live="polite"><span>Card total</span><strong>{cardQuote ? formatAmount(cardQuote.total, currency) : "—"}</strong></div>
                <button className="primary-button payment-option-button card-payment-button" type="submit" name="paymentMode" value="card" aria-describedby="card-fee card-total" disabled={preparing || !cardQuote || Boolean(pricingError)}>
                  <span>{preparing && paymentMode === "card" ? "Loading Card…" : "Continue to Payment (Card)"}</span><ArrowIcon />
                </button>
              </div>
            </div>
            <p className="panel-footnote">Totals shown in USD. Card payments include the 2.7% fee shown above.</p>
          </form>
        ) : (
          <>
            <h2 className="panel-title" ref={paymentTitleRef} tabIndex={-1}>One step from momentum.</h2>
            <p className="panel-description">{paymentMode === "card" ? "Pay by card securely with Whop." : "Pay by wire or ACH securely with Whop."}</p>
            <div className="payment-summary">
              <div><span>{selectedState?.name} · {leadCount} {leadCount === 1 ? "lead" : "leads"}</span><span>{quote ? formatAmount(quote.amount, currency) : "—"}</span></div>
              {paymentMode === "card" && <div className="fee-summary-row"><span>Card fee (2.7%)</span><span>{quote ? formatAmount(quote.fee, currency) : "—"}</span></div>}
              <div className="quote-total"><span>USD total</span><strong>{quote ? formatAmount(quote.total, currency) : "—"}</strong></div>
              <button className="text-button" type="button" onClick={changeAmount} disabled={preparing || completed}>Change state, leads or payment method</button>
            </div>
            {configured && planId && quote ? (
              <>
                {loadError && (
                  <div className="payment-load-error" role="alert">
                    <p className="form-error">We couldn’t load the secure payment form. Check your connection and try again.</p>
                    <button className="text-button" type="button" onClick={() => { loadError.retry(); setLoadError(null); }}>Reload payment form</button>
                  </div>
                )}
                <p className="currency-note">{paymentMode === "bank" ? "Wire and ACH payments are charged in USD." : forceUsd ? "Payment currency is USD." : "Your card checkout and local-currency total appear below."}</p>
                {elementError && <div className="payment-load-error" role="alert">
                  <p className="form-error">{elementError}</p>
                  <button className="text-button" type="button" onClick={() => { setElementError(null); setCheckoutLoading(true); setCheckoutVersion((version) => version + 1); }}>Reload checkout</button>
                </div>}
                <Checkout key={`${JSON.stringify(checkoutItems)}:${checkoutVersion}`} items={checkoutItems}
                  metadata={checkoutMetadata}
                  returnUrl={`${siteUrl}/checkout/return?order=${orderId}`}
                  onLoadingChange={setCheckoutLoading}
                  onComplete={() => setCompleted(true)}>
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
