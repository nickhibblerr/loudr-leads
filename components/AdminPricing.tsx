"use client";

import { useEffect, useState, type FormEvent } from "react";

type StatePrice = { code: string; name: string; price: number | null };
type RateCard = { version: string; updatedAt: string | null; states: StatePrice[] };
type Draft = { price: string; soldOut: boolean };

class AdminAccessError extends Error {
  constructor(public readonly status: 401 | 403) {
    super(status === 401 ? "Your session expired. Sign in again to manage prices." : "Your account no longer has access to Loudr Media’s admin page.");
  }
}

function draftsFor(card: RateCard): Record<string, Draft> {
  return Object.fromEntries(card.states.map((state) => [state.code, {
    price: state.price === null ? "" : String(state.price), soldOut: state.price === null,
  }]));
}

function draftPrice(draft: Draft): number | null {
  return draft.soldOut ? null : draft.price.trim() ? Number(draft.price) : NaN;
}

function validPrice(price: number | null): boolean {
  return price === null || (Number.isFinite(price) && price >= 0.01 && price <= 10_000 && Math.abs(price * 100 - Math.round(price * 100)) < 0.000001);
}

async function readCard(response: Response): Promise<RateCard> {
  if (response.status === 401 || response.status === 403) throw new AdminAccessError(response.status);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "We couldn’t load your prices. Please try again.");
  if (typeof body?.version !== "string" || !Array.isArray(body?.states)) throw new Error("We couldn’t read your prices. Please try again.");
  return body as RateCard;
}

export default function AdminPricing() {
  const [card, setCard] = useState<RateCard | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [accessFailure, setAccessFailure] = useState<401 | 403 | null>(null);
  const [saveRejected, setSaveRejected] = useState(false);

  function showFailure(cause: unknown, fallback: string, rejectedSave = false) {
    if (cause instanceof AdminAccessError) {
      setAccessFailure(cause.status);
      setSaveRejected(rejectedSave);
      setCard(null);
      setDrafts({});
      setMessage("");
    }
    setError(cause instanceof Error ? cause.message : fallback);
  }

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/admin/prices", { cache: "no-store", signal: controller.signal })
      .then(readCard)
      .then((next) => { setCard(next); setDrafts(draftsFor(next)); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) showFailure(cause, "We couldn’t load your prices."); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const changes = card?.states.flatMap((state) => {
    const draft = drafts[state.code];
    if (!draft) return [];
    const price = draftPrice(draft);
    return price !== state.price ? [{ code: state.code, price }] : [];
  }) ?? [];
  const dirtyCount = changes.length;
  const invalidChanges = changes.filter((change) => !validPrice(change.price));
  const visibleStates = card?.states.filter((state) => `${state.name} ${state.code}`.toLowerCase().includes(search.trim().toLowerCase())) ?? [];
  const pending = loading || saving;

  useEffect(() => {
    if (!dirtyCount) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirtyCount]);

  async function reloadPrices() {
    setLoading(true);
    setError(null);
    try {
      const next = await readCard(await fetch("/api/admin/prices", { cache: "no-store" }));
      setCard(next);
      setDrafts(draftsFor(next));
      setConflict(false);
      setMessage("Latest prices loaded.");
    } catch (cause) {
      showFailure(cause, "We couldn’t load your prices. Please try again.");
    } finally { setLoading(false); }
  }

  function updateDraft(code: string, update: Partial<Draft>) {
    setDrafts((current) => ({ ...current, [code]: { ...current[code], ...update } }));
    setMessage("");
    if (!conflict) setError(null);
  }

  function resetChanges() {
    if (!card) return;
    setDrafts(draftsFor(card));
    setMessage("Unsaved changes reset.");
    if (!conflict) setError(null);
  }

  async function saveChanges(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!card || saving || conflict || !dirtyCount) return;
    if (invalidChanges.length) {
      setError("Enter a price between $0.01 and $10,000, using no more than two decimal places, for every available state.");
      document.getElementById(`price-${invalidChanges[0].code}`)?.focus();
      return;
    }
    setSaving(true);
    setError(null);
    setMessage("");
    try {
      const response = await fetch("/api/admin/prices", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ version: card.version, changes }),
      });
      if (response.status === 409) {
        setConflict(true);
        setError("Prices changed in another session. Your edits are still here. Reload the latest prices before saving again.");
        return;
      }
      const next = await readCard(response);
      setCard(next);
      setDrafts(draftsFor(next));
      setMessage(`Saved ${dirtyCount} ${dirtyCount === 1 ? "state" : "states"}. New checkouts use these prices.`);
    } catch (cause) {
      showFailure(cause, "Your changes weren’t saved. Please try again.", true);
    } finally { setSaving(false); }
  }

  if (accessFailure) return (
    <section className="admin-empty">
      <p className="form-error" role="alert">{error}</p>
      {saveRejected && <p>Your latest changes weren’t saved.</p>}
      {accessFailure === 401 ? <a href="/admin/login" className="admin-entry-button admin-sign-in-link">Sign in again</a> : <form action="/api/auth/logout" method="post"><button className="admin-secondary" type="submit">Sign in again</button></form>}
    </section>
  );

  if (!card) return (
    <section className="admin-empty" aria-busy={loading}>
      {loading ? <p role="status">Loading state prices…</p> : <>
        <p className="form-error" role="alert">{error}</p>
        <button className="admin-secondary" type="button" onClick={reloadPrices}>Try again</button>
      </>}
    </section>
  );

  return (
    <form className="admin-pricing" onSubmit={saveChanges} noValidate aria-busy={pending}>
      <div className="admin-toolbar">
        <div>
          <label htmlFor="state-search">Find a state</label>
          <input id="state-search" type="search" placeholder="State name or abbreviation" value={search} onChange={(event) => setSearch(event.target.value)} />
        </div>
        <span className="admin-count">{visibleStates.length} of {card.states.length} states <span aria-hidden="true">·</span> USD</span>
      </div>
      <div className="admin-table-wrap" tabIndex={0} role="region" aria-label="Editable state prices">
        <table className="admin-table">
          <caption className="admin-sr-only">Edit price per lead and availability for each state. Save changes to apply them to new checkouts.</caption>
          <thead><tr><th scope="col">State</th><th scope="col">Price per lead</th><th scope="col">Availability</th></tr></thead>
          <tbody>
            {visibleStates.map((state) => {
              const draft = drafts[state.code];
              const price = draftPrice(draft);
              const changed = price !== state.price;
              const invalid = changed && !validPrice(price);
              return (
                <tr key={state.code} className={changed ? "admin-row-changed" : undefined}>
                  <th scope="row"><span className="admin-state-code">{state.code}</span><span>{state.name}</span>{changed && <span className="admin-unsaved">Unsaved</span>}</th>
                  <td>
                    <label className={`admin-price${invalid ? " invalid" : ""}`} htmlFor={`price-${state.code}`}>
                      <span aria-hidden="true">$</span>
                      <input id={`price-${state.code}`} aria-label={`${state.name} price per lead`} type="number" inputMode="decimal" min="0.01" max="10000" step="0.01"
                        value={draft.price} placeholder={draft.soldOut ? "—" : "0.00"} disabled={pending || draft.soldOut}
                        aria-invalid={invalid} aria-describedby={invalid ? `price-error-${state.code}` : undefined}
                        onChange={(event) => updateDraft(state.code, { price: event.target.value })} />
                    </label>
                    {invalid && <span id={`price-error-${state.code}`} className="admin-price-error">Use $0.01–$10,000, up to 2 decimals.</span>}
                  </td>
                  <td><label className="admin-availability"><input type="checkbox" checked={draft.soldOut} disabled={pending} aria-label={`${state.name} sold out`} onChange={(event) => updateDraft(state.code, { soldOut: event.target.checked })} /><span>Sold out</span></label></td>
                </tr>
              );
            })}
            {!visibleStates.length && <tr><td colSpan={3} className="admin-no-results">No states match “{search}”.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="admin-feedback">
        {error && <p className="form-error" role="alert">{error}</p>}
        {conflict && <button className="admin-secondary" type="button" disabled={pending} onClick={reloadPrices}>Discard edits &amp; reload latest</button>}
        <p className="admin-save-message" role="status" aria-live="polite">{message}</p>
      </div>
      <div className="admin-save-bar">
        <div><strong>{dirtyCount ? `${dirtyCount} unsaved ${dirtyCount === 1 ? "change" : "changes"}` : "All changes saved"}</strong><p>{card.updatedAt ? `Last saved ${new Date(card.updatedAt).toLocaleString()}` : "Your current prices are ready to edit."}</p></div>
        <div className="admin-save-actions">
          <button className="admin-secondary" type="button" disabled={pending || !dirtyCount} onClick={resetChanges}>Reset</button>
          <button className="primary-button" type="submit" disabled={pending || !dirtyCount || conflict || invalidChanges.length > 0}>{saving ? "Saving…" : "Save changes"}</button>
        </div>
      </div>
    </form>
  );
}
