"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import LeadSelector from "@/components/LeadSelector";
import { ArrowIcon } from "@/components/Icons";
import { calculateCartQuote, MAX_CART_STATES, type CartQuote } from "@/lib/lead-cart";
import type { OrderMode } from "@/lib/leads";
import { amountError, convertedValue, leadCountFor, leadsLabel, newOrderLine, stateErrorFor, type OrderLine } from "@/lib/order-lines";
import { CARD_FEE_LABEL, type PaymentMode } from "@/lib/payment-methods";
import type { RateCard } from "@/lib/rate-card";
import { formatAmount } from "@/lib/top-up";

type Props = { reps: string[]; signedInName: string | null; proposalsConnected: boolean };
type Client = { firstName: string; lastName: string; email: string; phone: string; firm: string };
type GeneratedLink = { key: string; url: string; planId: string; paymentMode: PaymentMode; total: number; leadCount: number; createdAt: string };
type SentProposal = { email: string; signingUrl: string | null; cardUrl: string | null; wireUrl: string | null; cardTotal: string | null; wireTotal: string | null; proposalId: string };

const EMPTY_CLIENT: Client = { firstName: "", lastName: "", email: "", phone: "", firm: "" };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong. Please try again.";
}

async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    // Older browsers / denied clipboard permission: fall back to a selected text area.
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch { ok = false; }
    area.remove();
    return ok;
  }
}

function CopyField({ id, label, url }: { id: string; label: string; url: string }) {
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setCopied(false); }, [url]);
  return (
    <div className="team-copy-field">
      <label htmlFor={id}>{label}</label>
      <div className="team-copy-row">
        <input id={id} ref={inputRef} readOnly value={url} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="team-copy-button" onClick={async () => {
          const ok = await copyText(url);
          if (!ok) inputRef.current?.select();
          setCopied(ok);
          if (ok) setTimeout(() => setCopied(false), 2500);
        }}>{copied ? "Copied" : "Copy link"}</button>
      </div>
      <a className="team-open-link" href={url} target="_blank" rel="noopener noreferrer">Open checkout ↗</a>
      <span className="visually-hidden" aria-live="polite">{copied ? "Link copied to clipboard" : ""}</span>
    </div>
  );
}

export default function TeamProposal({ reps, signedInName, proposalsConnected }: Props) {
  const [rateCard, setRateCard] = useState<RateCard | null>(null);
  const [pricingError, setPricingError] = useState<string | null>(null);
  const [lines, setLines] = useState<OrderLine[]>(() => [newOrderLine()]);
  const [activeId, setActiveId] = useState(() => lines[0].id);
  const [stateTouched, setStateTouched] = useState(false);
  const [touched, setTouched] = useState(false);
  const stateRef = useRef<HTMLSelectElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const [rep, setRep] = useState(() => reps.find((name) => signedInName && name.toLowerCase() === signedInName.toLowerCase()) ?? "");
  const [client, setClient] = useState<Client>(EMPTY_CLIENT);
  const [clientTouched, setClientTouched] = useState(false);

  const [paymentMode, setPaymentMode] = useState<PaymentMode>("bank");
  const [link, setLink] = useState<GeneratedLink | null>(null);
  const [generatedPlanIds, setGeneratedPlanIds] = useState<string[]>([]);
  const [retireGenerated, setRetireGenerated] = useState(true);
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkError, setLinkError] = useState<string | null>(null);

  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<SentProposal | null>(null);
  const busy = linkBusy || sending;

  // Current prices: on load, every 30 seconds while visible, and when the tab regains focus.
  const [pricingRetry, setPricingRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    async function refresh() {
      if (document.visibilityState === "hidden") return;
      try {
        const response = await fetch("/api/prices", { cache: "no-store", signal: controller.signal });
        const next: RateCard = await response.json();
        if (!response.ok || !Array.isArray(next.states) || typeof next.version !== "string") throw new Error("Unable to load current prices. Please retry.");
        if (!controller.signal.aborted) { setRateCard(next); setPricingError(null); }
      } catch (error) {
        if (!controller.signal.aborted) setPricingError(errorMessage(error));
      }
    }
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 30_000);
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [pricingRetry]);

  const active = lines.find((line) => line.id === activeId) ?? lines[0];
  const rateFor = (code: string) => rateCard?.states.find((item) => item.code === code);
  const selectedState = rateFor(active.state);
  const multiple = lines.length > 1;
  const stateError = rateCard && (stateTouched || (active.state && selectedState?.price === null)) ? stateErrorFor(active, selectedState) : null;
  const error = touched ? amountError(active, selectedState) : null;
  const usedStates = useMemo(() => new Set(lines.filter((line) => line.id !== active.id).map((line) => line.state)), [lines, active.id]);
  const lineValid = (line: OrderLine) => !stateErrorFor(line, rateFor(line.state)) && !amountError(line, rateFor(line.state));
  const allValid = lines.every(lineValid);
  const items = allValid ? lines.map((line) => ({ state: line.state, quantity: leadCountFor(line, rateFor(line.state)) ?? 0 })) : [];
  const itemsKey = JSON.stringify(items);
  const quotes = useMemo(() => {
    if (!rateCard || !items.length) return null;
    try { return { bank: calculateCartQuote(items, rateCard.states, "bank"), card: calculateCartQuote(items, rateCard.states, "card") }; }
    catch { return null; }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsKey, rateCard]);
  const quote: CartQuote | null = quotes ? quotes[paymentMode === "card" ? "card" : "bank"] : null;
  const orderKey = `${itemsKey}|${paymentMode}|${rateCard?.version ?? ""}`;
  const linkCurrent = Boolean(link && link.key === orderKey);
  const canAddState = lines.length < MAX_CART_STATES && (!rateCard || rateCard.states.some((item) => item.price !== null && !lines.some((line) => line.state === item.code)));

  const clientErrors = {
    firstName: client.firstName.trim() ? null : "Enter the client’s first name.",
    email: EMAIL.test(client.email.trim()) ? null : "Enter a valid client email.",
    firm: client.firm.trim() ? null : "Enter the law firm name.",
    rep: rep ? null : "Choose your name.",
  };
  const clientValid = !Object.values(clientErrors).some(Boolean);

  function updateActive(change: Partial<OrderLine>) {
    setLines((current) => current.map((line) => line.id === active.id ? { ...line, ...change } : line));
    setLinkError(null); setSendError(null); setSent(null);
  }
  function changeMode(mode: OrderMode) {
    const value = convertedValue(active, selectedState, mode);
    updateActive({ mode, value });
    setTouched(Boolean(value));
    requestAnimationFrame(() => inputRef.current?.focus());
  }
  function activate(id: string, focus: "state" | "amount" = "amount") {
    if (busy) return;
    setActiveId(id); setStateTouched(false); setTouched(false);
    requestAnimationFrame(() => (focus === "state" ? stateRef.current : inputRef.current)?.focus());
  }
  function revealFirstInvalid(): boolean {
    const invalid = lines.find((line) => !lineValid(line));
    if (!invalid) return false;
    setActiveId(invalid.id); setStateTouched(true); setTouched(true);
    const focusState = Boolean(stateErrorFor(invalid, rateFor(invalid.state)));
    requestAnimationFrame(() => (focusState ? stateRef.current : inputRef.current)?.focus());
    return true;
  }
  function addState() {
    if (busy || !canAddState) return;
    if (!lineValid(active)) { revealFirstInvalid(); return; }
    const line = newOrderLine("", "", active.mode);
    setLines((current) => [...current, line]);
    activate(line.id, "state");
  }
  function removeLine(id: string) {
    if (busy) return;
    const index = lines.findIndex((line) => line.id === id);
    const remaining = lines.filter((line) => line.id !== id);
    if (!remaining.length) return;
    setLines(remaining); setSent(null);
    if (id === active.id) activate(remaining[Math.max(0, index - 1)].id);
  }
  function setClientField(field: keyof Client, value: string) {
    setClient((current) => ({ ...current, [field]: value }));
    setSendError(null);
  }
  function handleStaleRates(response: Response, body: { rateCard?: RateCard }) {
    if (response.status === 409 && body.rateCard) setRateCard(body.rateCard);
  }

  async function generateLink() {
    if (busy) return;
    if (revealFirstInvalid() || !quote || !rateCard) return;
    setLinkBusy(true); setLinkError(null);
    const key = orderKey;
    try {
      const response = await fetch("/api/team/payment-link", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(30_000),
        body: JSON.stringify({ items, paymentMode, priceVersion: rateCard.version, rep: rep || undefined,
          client: { firstName: client.firstName, lastName: client.lastName, email: client.email, firm: client.firm } }),
      });
      const body = await response.json();
      handleStaleRates(response, body);
      if (!response.ok || typeof body.url !== "string" || typeof body.planId !== "string") throw new Error(body.error || "We couldn’t create the payment link. Please try again.");
      if (Math.round(body.cart?.totalCents) !== quote.totalCents) throw new Error("The link total didn’t match this order. Please generate it again.");
      setLink({ key, url: body.url, planId: body.planId, paymentMode, total: quote.total, leadCount: quote.leadCount, createdAt: body.createdAt });
      setGeneratedPlanIds((current) => [...new Set([...current, body.planId])].slice(-20));
    } catch (cause) {
      setLinkError(cause instanceof Error && cause.name === "TimeoutError" ? "Whop took too long to respond. Please try again." : errorMessage(cause));
    } finally { setLinkBusy(false); }
  }

  async function sendProposal() {
    if (busy || !proposalsConnected) return;
    setClientTouched(true);
    if (revealFirstInvalid() || !quotes || !rateCard) return;
    if (!clientValid) { document.querySelector<HTMLElement>(".team-client [aria-invalid='true']")?.focus(); return; }
    setSending(true); setSendError(null); setSent(null);
    try {
      const response = await fetch("/api/team/proposal", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(115_000),
        body: JSON.stringify({ items, priceVersion: rateCard.version, rep, client, retirePlanIds: retireGenerated ? generatedPlanIds : [] }),
      });
      const body = await response.json();
      handleStaleRates(response, body);
      if (!response.ok || body.sent !== true) throw new Error(body.error || "The proposal wasn’t confirmed as sent. Check GHL before trying again.");
      setSent({ email: body.email, signingUrl: body.signingUrl, cardUrl: body.cardUrl, wireUrl: body.wireUrl,
        cardTotal: body.cardTotal, wireTotal: body.wireTotal, proposalId: body.proposalId });
      if (retireGenerated) setGeneratedPlanIds([]);
    } catch (cause) {
      setSendError(cause instanceof Error && cause.name === "TimeoutError"
        ? "No answer from the automation yet. Check the contact in GHL before sending again — the proposal may already have gone out."
        : errorMessage(cause));
    } finally { setSending(false); }
  }

  const fieldError = (key: keyof typeof clientErrors) => clientTouched ? clientErrors[key] : null;

  return (
    <div className="team-grid">
      <section className="checkout-panel team-panel" aria-labelledby="team-order-heading">
        <div className="panel-topline">
          <span className="panel-caption">Order</span>
          <span className="step-counter">01<span> / 02</span></span>
        </div>
        <h2 className="panel-title" id="team-order-heading">What they’re buying.</h2>
        <p className="panel-description">{multiple ? "Set a budget or lead count for each state." : "Pick a state, then set a budget or a lead count. Add more states for a multi-state deal."}</p>

        {!rateCard && !pricingError && <p role="status" className="panel-footnote">Loading current prices…</p>}
        {pricingError && <div role="alert"><p className="form-error">{pricingError}</p><button type="button" className="text-button" onClick={() => setPricingRetry((n) => n + 1)}>Retry prices</button></div>}

        {multiple && (
          <div className="cart-block">
            <p className="cart-heading" id="team-cart-heading">This deal <span>{lines.length} states</span></p>
            <ul className="cart-lines" aria-labelledby="team-cart-heading">
              {lines.map((line) => {
                const rate = rateFor(line.state);
                const count = leadCountFor(line, rate) ?? 0;
                const valid = lineValid(line);
                const isActive = line.id === active.id;
                return (
                  <li key={line.id} className={`cart-line${isActive ? " active" : ""}${!valid && !isActive ? " incomplete" : ""}`}>
                    <button type="button" className="cart-line-main" onClick={() => activate(line.id)} aria-current={isActive ? "true" : undefined} disabled={busy}>
                      <span className="cart-line-state">{rate ? <>{rate.name} <span>{rate.code}</span></> : "New state"}</span>
                      <span className="cart-line-meta">{valid && rate?.price ? <>{leadsLabel(count)} · {formatAmount(rate.price * count)}</> : rate?.price === null ? "Sold out" : isActive ? "Editing" : "Needs details"}</span>
                    </button>
                    <button type="button" className="cart-line-remove" onClick={() => removeLine(line.id)} disabled={busy} aria-label={`Remove ${rate?.name ?? "this state"} from the deal`}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        <label className="state-label" htmlFor="lead-state">{multiple ? `State ${lines.findIndex((line) => line.id === active.id) + 1} of ${lines.length}` : "State"}</label>
        <select id="lead-state" className="state-field" ref={stateRef} value={active.state} disabled={busy || !rateCard}
          onChange={(event) => { updateActive({ state: event.target.value }); setStateTouched(true); }}
          onBlur={() => setStateTouched(true)} aria-invalid={Boolean(stateError)} aria-describedby={stateError ? "state-error" : undefined}>
          <option value="" disabled>Select a state</option>
          {rateCard?.states.map((item) => <option key={item.code} value={item.code} disabled={item.price === null || usedStates.has(item.code)}>
            {item.name} ({item.code}) — {item.price === null ? "Sold out" : usedStates.has(item.code) ? "In this deal" : `${formatAmount(item.price)} / lead`}
          </option>)}
        </select>
        {stateError && <p id="state-error" className="form-error" role="alert">{stateError}</p>}
        <LeadSelector mode={active.mode} onModeChange={changeMode} value={active.value} onChange={(next) => { updateActive({ value: next }); setTouched(true); }}
          onBlur={() => setTouched(true)} error={error} disabled={busy} unitPrice={selectedState?.price ?? null} inputRef={inputRef} />

        <button type="button" className="add-state-button" onClick={addState} disabled={busy || !canAddState || !rateCard}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" /></svg>
          {canAddState ? "Add another state" : lines.length >= MAX_CART_STATES ? `Up to ${MAX_CART_STATES} states per deal` : "Every available state is in this deal"}
        </button>

        <div className="quote-summary" aria-live="polite">
          {(quotes?.bank.lines ?? []).map((line) => (
            <div key={line.state}><span>{line.stateName} · {line.leadCount.toLocaleString("en-US")} × {formatAmount(line.unitPrice)}</span><span>{formatAmount(line.amount)}</span></div>
          ))}
          <div className="cart-subtotal"><span>Lead subtotal{quotes ? ` (${leadsLabel(quotes.bank.leadCount)})` : ""}</span><span>{quotes ? formatAmount(quotes.bank.amount) : "—"}</span></div>
          <div><span>Wire total</span><span>{quotes ? formatAmount(quotes.bank.total) : "—"}</span></div>
          <div><span>Card total (incl. {CARD_FEE_LABEL} fee {quotes ? formatAmount(quotes.card.fee) : ""})</span><span>{quotes ? formatAmount(quotes.card.total) : "—"}</span></div>
        </div>
      </section>

      <section className="checkout-panel team-panel" aria-labelledby="team-send-heading">
        <div className="panel-topline">
          <span className="panel-caption">Client</span>
          <span className="step-counter">02<span> / 02</span></span>
        </div>
        <h2 className="panel-title" id="team-send-heading">Close it.</h2>
        <p className="panel-description">Copy a payment link to drop in the call chat, or send the full proposal with card and wire links through GHL.</p>

        <div className="team-client">
          <div className="team-field team-field-full">
            <label htmlFor="team-rep">Your name</label>
            <select id="team-rep" className="state-field" value={rep} onChange={(event) => setRep(event.target.value)} disabled={busy}
              aria-invalid={Boolean(fieldError("rep"))} aria-describedby={fieldError("rep") ? "team-rep-error" : undefined}>
              <option value="" disabled>Select your name</option>
              {reps.map((name) => <option key={name} value={name}>{name}</option>)}
            </select>
            {fieldError("rep") && <p id="team-rep-error" className="form-error">{fieldError("rep")}</p>}
          </div>
          {([
            ["firstName", "Client first name", "text"],
            ["lastName", "Client last name (optional)", "text"],
            ["email", "Client email", "email"],
            ["phone", "Phone (optional)", "tel"],
            ["firm", "Law firm name", "text"],
          ] as const).map(([field, label, type]) => {
            const fieldErr = field in clientErrors ? fieldError(field as keyof typeof clientErrors) : null;
            return (
              <div key={field} className={`team-field${field === "firm" || field === "email" ? " team-field-full" : ""}`}>
                <label htmlFor={`team-${field}`}>{label}</label>
                <input id={`team-${field}`} type={type} autoComplete="off" value={client[field]} disabled={busy}
                  onChange={(event) => setClientField(field, event.target.value)}
                  aria-invalid={Boolean(fieldErr)} aria-describedby={fieldErr ? `team-${field}-error` : undefined} />
                {fieldErr && <p id={`team-${field}-error`} className="form-error">{fieldErr}</p>}
              </div>
            );
          })}
        </div>

        <div className="team-section">
          <div className="team-section-head">
            <h3>Payment link</h3>
            <div className="mode-toggle" role="group" aria-label="Payment method for the link">
              {(["bank", "card"] as const).map((mode) => (
                <button key={mode} type="button" className={paymentMode === mode ? "selected" : undefined} aria-pressed={paymentMode === mode}
                  disabled={busy} onClick={() => { setPaymentMode(mode); setLinkError(null); }}>{mode === "card" ? "Card" : "Wire"}</button>
              ))}
            </div>
          </div>
          <p className="team-section-note">{paymentMode === "card" ? `Card total ${quotes ? formatAmount(quotes.card.total) : "—"}, including the ${CARD_FEE_LABEL} card fee. Card links can be paid once.` : `Wire total ${quotes ? formatAmount(quotes.bank.total) : "—"}. No additional fee.`}</p>
          <button type="button" className="primary-button" onClick={generateLink} disabled={busy || !rateCard || Boolean(pricingError)}>
            <span>{linkBusy ? "Creating link…" : link && !linkCurrent ? "Generate new link" : `Generate ${paymentMode === "card" ? "card" : "wire"} payment link`}</span><ArrowIcon />
          </button>
          {linkError && <p className="form-error" role="alert">{linkError}</p>}
          {link && (
            <div className={`team-link${linkCurrent ? "" : " stale"}`}>
              <CopyField id="team-payment-link" label={`${link.paymentMode === "card" ? "Card" : "Wire"} link · ${leadsLabel(link.leadCount)} · ${formatAmount(link.total)}`} url={link.url} />
              {!linkCurrent && <p className="team-stale-note" role="status">The deal changed since this link was made. Generate a new link so the amount matches.</p>}
            </div>
          )}
        </div>

        <div className="team-section">
          <h3>Proposal</h3>
          <p className="team-section-note">Saves the client in GHL, creates fresh card and wire links, and sends your proposal document — the same automation as before.</p>
          {generatedPlanIds.length > 0 && (
            <label className="team-check">
              <input type="checkbox" checked={retireGenerated} onChange={(event) => setRetireGenerated(event.target.checked)} disabled={busy} />
              <span>Turn off the {generatedPlanIds.length === 1 ? "link" : `${generatedPlanIds.length} links`} I generated here once the proposal is sent</span>
            </label>
          )}
          <button type="button" className="primary-button team-send-button" onClick={sendProposal} disabled={busy || !proposalsConnected || !rateCard || Boolean(pricingError)}>
            <span>{sending ? "Sending proposal…" : "Send Proposal"}</span><ArrowIcon />
          </button>
          {!proposalsConnected && <p className="team-section-note" role="status">Proposal sending isn’t connected yet. An admin needs to add the n8n webhook in the site settings.</p>}
          {sending && <p className="team-section-note" role="status">Creating links and sending through GHL. This can take up to a minute — don’t send it twice.</p>}
          {sendError && <p className="form-error" role="alert">{sendError}</p>}
          {sent && (
            <div className="team-sent" role="status">
              <p className="team-sent-title">Proposal sent to {sent.email}.</p>
              {sent.signingUrl && <CopyField id="team-signing-link" label="Proposal link to sign now" url={sent.signingUrl} />}
              {sent.cardUrl && <CopyField id="team-sent-card" label={`Pay by card${sent.cardTotal ? `, ${sent.cardTotal}` : ""}`} url={sent.cardUrl} />}
              {sent.wireUrl && <CopyField id="team-sent-wire" label={`Pay by wire${sent.wireTotal ? `, ${sent.wireTotal}` : ""}`} url={sent.wireUrl} />}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
