import type { Metadata } from "next";
import Link from "next/link";
import Brand from "@/components/Brand";
import { ArrowIcon } from "@/components/Icons";
import ClearSavedCart from "./ClearSavedCart";

export const metadata: Metadata = { title: "Payment update | LOUDR Media" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function CheckoutReturn({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  const status = typeof params.status === "string" ? params.status : "";
  const succeeded = status === "succeeded";
  const failed = status === "failed" || status === "canceled";
  const reference = typeof params.payment === "string" ? params.payment : typeof params.order === "string" ? params.order : null;

  // Display only: query parameters are buyer-controlled. Only a verified
  // payment.succeeded webhook may authorize a balance credit.
  return (
    <div className="site-shell return-shell">
      {!failed && <ClearSavedCart />}
      <header className="site-header"><Brand /><span className="header-note">Payment update</span></header>
      <main className="return-main">
        <section className="return-panel" aria-labelledby="return-heading">
          <div className="return-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              {succeeded ? <path d="m5 12 4 4L19 6" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" /> : failed ? <path d="m7 7 10 10M17 7 7 17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /> : <><circle cx="12" cy="12" r="8" stroke="currentColor" strokeWidth="1.5" /><path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></>}
            </svg>
          </div>
          <h1 id="return-heading">{succeeded ? "Funds received" : failed ? "Payment didn’t go through." : "Confirming your payment"}</h1>
          <p className="return-description">
            {succeeded ? "Thank you for fueling your next phase of growth. Your lead order will be reviewed once your payment is verified." : failed ? "You weren’t charged. Head back to choose your leads and try again." : "Your payment is being confirmed. Wire transfers typically take 1–3 business days to settle. Your lead order will be reviewed once the funds arrive."}
          </p>
          {(reference || succeeded) && <dl className="reference"><dt>Payment reference</dt><dd>{reference || "Your reference will appear in your payment receipt."}</dd></dl>}
          <Link href="/" className="primary-button">{failed ? "Try again" : "Back to LOUDR Media"}<ArrowIcon /></Link>
          <p className="return-fineprint">This page is a payment update. Orders depend on verified payment confirmation.</p>
        </section>
      </main>
      <footer className="site-footer"><span>© {new Date().getFullYear()} LOUDR Media</span><span>Built for your next level.</span></footer>
    </div>
  );
}
