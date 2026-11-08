"use client";

import type { Ref } from "react";
import { isValidLeadCount, leadGuidance, LEAD_PRESETS } from "@/lib/leads";

type Props = {
  value: string;
  onChange: (value: string) => void;
  onBlur: () => void;
  error: string | null;
  disabled: boolean;
  max: number;
  inputRef: Ref<HTMLInputElement>;
};

export default function LeadSelector({ value, onChange, onBlur, error, disabled, max, inputRef }: Props) {
  const count = Number(value);
  const valid = value.trim() !== "" && isValidLeadCount(count) && count <= max;
  const guidance = valid ? leadGuidance(count) : null;

  return (
    <>
        <label className="amount-label" htmlFor="lead-count">Number of leads <span>Choose your volume</span></label>
        <div className={`amount-field${error ? " has-error" : ""}`}>
          <input id="lead-count" name="leadCount" type="number" inputMode="numeric" min="1" max={max} step="1" ref={inputRef} disabled={disabled}
            value={value} placeholder="0" autoComplete="off"
            onChange={(event) => onChange(event.target.value)}
            onBlur={onBlur} aria-invalid={Boolean(error)}
            aria-describedby={error ? "lead-error lead-hint" : "lead-hint"} />
          <span className="lead-unit" aria-hidden="true">{count === 1 ? "lead" : "leads"}</span>
        </div>
        <div className="amount-help">
          <p id="lead-hint">Select a package or enter any custom quantity.</p>
          {error && <p className="form-error" id="lead-error" role="alert">{error}</p>}
        </div>
        <div className="preset-grid" role="group" aria-label="Suggested lead quantities">
          {LEAD_PRESETS.map((quantity) => (
            <button key={quantity} type="button" className={`preset${count === quantity ? " selected" : ""}`}
              aria-label={`${quantity} leads`} aria-pressed={count === quantity}
              disabled={disabled} onClick={() => onChange(String(quantity))}>{quantity}</button>
          ))}
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
