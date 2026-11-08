"use client";

import type { Ref } from "react";
import { BUDGET_PRESETS, leadGuidance, LEAD_PRESETS, type OrderMode } from "@/lib/leads";
import { leadsForBudget } from "@/lib/lead-cart";
import { MAX_LEAD_QUANTITY, MIN_LEAD_QUANTITY } from "@/lib/lead-pricing";
import { formatAmount } from "@/lib/top-up";
import { CARD_FEE_LABEL } from "@/lib/payment-methods";

type Props = {
  mode: OrderMode;
  onModeChange: (mode: OrderMode) => void;
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error: string | null;
  disabled: boolean;
  /** Price per lead for the selected state, or null before a state is chosen. */
  unitPrice: number | null;
  inputRef: Ref<HTMLInputElement>;
};

const compactDollars = (amount: number) => amount >= 1000 && amount % 1000 === 0 ? `$${amount / 1000}k` : formatAmount(amount);

export default function LeadSelector({ mode, onModeChange, value, onChange, onBlur, error, disabled, unitPrice, inputRef }: Props) {
  const entered = Number(value);
  const budget = mode === "budget" && value.trim() !== "" && unitPrice ? leadsForBudget(entered, unitPrice) : null;
  const count = mode === "leads" ? entered : budget?.leadCount ?? 0;
  const valid = !error && Number.isSafeInteger(count) && count >= MIN_LEAD_QUANTITY && count <= MAX_LEAD_QUANTITY;
  const guidance = valid ? leadGuidance(count) : null;
  const presets = mode === "leads" ? LEAD_PRESETS : BUDGET_PRESETS;
  const inputId = mode === "leads" ? "lead-count" : "lead-budget";

  return (
    <>
        <div className="amount-label-row">
          <label className="amount-label" htmlFor={inputId}>{mode === "leads" ? "Number of leads" : "Your lead budget"}</label>
          <div className="mode-toggle" role="group" aria-label="Choose by">
            {(["leads", "budget"] as const).map((option) => (
              <button key={option} type="button" className={mode === option ? "selected" : undefined} aria-pressed={mode === option}
                disabled={disabled} onClick={() => mode !== option && onModeChange(option)}>{option === "leads" ? "Leads" : "Budget"}</button>
            ))}
          </div>
        </div>
        <div className={`amount-field${error ? " has-error" : ""}`}>
          {mode === "budget" && <span className="amount-prefix" aria-hidden="true">$</span>}
          <input key={inputId} id={inputId} name={mode === "leads" ? "leadCount" : "leadBudget"} type="number" inputMode="numeric" min="1" step="1"
            ref={inputRef} disabled={disabled} value={value} placeholder="0" autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur} aria-invalid={Boolean(error)}
            aria-describedby={[error ? "lead-error" : "", "lead-hint", budget ? "budget-result" : ""].filter(Boolean).join(" ")} />
          {mode === "leads" && <span className="lead-unit" aria-hidden="true">{entered === 1 ? "lead" : "leads"}</span>}
        </div>
        <div className="amount-help">
          {mode === "budget" && budget && valid && (
            <p className="budget-result" id="budget-result">
              = <strong>{count.toLocaleString("en-US")} leads</strong> · {formatAmount(budget.spentCents / 100)}
              {budget.leftoverCents > 0 && <span className="budget-leftover"> ({formatAmount(budget.leftoverCents / 100)} left over)</span>}
            </p>
          )}
          <p id="lead-hint">{mode === "leads"
            ? `Select a package or enter any quantity — minimum ${MIN_LEAD_QUANTITY} leads.`
            : `We’ll fit as many whole leads as your budget covers — minimum ${MIN_LEAD_QUANTITY}. Card payments add the ${CARD_FEE_LABEL} fee on top.`}</p>
          {error && <p className="form-error" id="lead-error" role="alert">{error}</p>}
        </div>
        <div className="preset-grid" role="group" aria-label={mode === "leads" ? "Suggested lead quantities" : "Suggested budgets"}>
          {presets.map((preset) => {
            const fit = mode === "budget" && unitPrice ? leadsForBudget(preset, unitPrice) : null;
            const outOfRange = Boolean(fit && (fit.leadCount < MIN_LEAD_QUANTITY || fit.leadCount > MAX_LEAD_QUANTITY));
            return (
              <button key={preset} type="button" className={`preset${entered === preset ? " selected" : ""}`}
                aria-label={mode === "leads" ? `${preset} leads` : `${formatAmount(preset)} budget${fit ? `, ${fit.leadCount} leads` : ""}`}
                aria-pressed={entered === preset} disabled={disabled || outOfRange}
                title={outOfRange && fit ? (fit.leadCount < MIN_LEAD_QUANTITY ? `Below the ${MIN_LEAD_QUANTITY}-lead minimum for this state` : "Above the 1,000-lead maximum") : undefined}
                onClick={() => onChange(String(preset))}>{mode === "leads" ? preset : compactDollars(preset)}</button>
            );
          })}
        </div>
        <div role="status" aria-live="polite" aria-atomic="true">
          {guidance && <div className="lead-confidence" data-tone={guidance.tone}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.5" />
              <path d="M12 11v6m0-10v1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <div><h3>{guidance.title}</h3><p>{guidance.description}</p></div>
          </div>}
        </div>
        {guidance && <p className="panel-footnote">More leads create more opportunities. Results depend on fit and follow-up.</p>}
    </>
  );
}
