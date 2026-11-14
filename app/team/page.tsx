import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import ThemeToggle from "@/components/ThemeToggle";
import TeamProposal from "@/components/TeamProposal";
import { getAdminAccess } from "@/lib/admin-auth";
import { teamRepNames } from "@/lib/team-proposal";
import "../admin/admin.css";
import "./team.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Proposals & payment links | LOUDR Team", robots: { index: false, follow: false } };

export default async function TeamPage() {
  const access = await getAdminAccess((await headers()).get("cookie"));
  if (access.status === "unauthenticated") redirect("/admin/login?next=team");
  const allowed = access.status === "authorized";
  const reps = teamRepNames();
  const proposalsConnected = Boolean(process.env.N8N_PROPOSAL_WEBHOOK_URL && process.env.N8N_PROPOSAL_WEBHOOK_SECRET);
  return (
    <div className="site-shell admin-shell">
      <a href="#team-proposal" className="skip-link">Skip to the proposal builder</a>
      <header className="site-header">
        <Brand />
        <nav className="admin-header-actions" aria-label="Team navigation">
          <a href="/" className="admin-entry-button">Back to checkout</a>
          <a href="/admin" className="admin-entry-button">Admin</a>
          <form action="/api/auth/logout" method="post"><button type="submit" className="admin-secondary">Sign out</button></form>
          <ThemeToggle />
        </nav>
      </header>
      <main id="team-proposal" className="admin-main team-main">
        <p className="eyebrow"><span className="eyebrow-line" /> Team</p>
        {allowed ? <>
          <h1>Build the deal<span className="accent-text">.</span></h1>
          <p className="admin-intro">Set each state by budget or lead count, then copy a Whop payment link for the call or send the client a proposal. Prices come from the current rate card.</p>
          <TeamProposal reps={reps} signedInName={access.name} proposalsConnected={proposalsConnected} />
        </> : <section className="admin-access-panel" aria-labelledby="access-heading">
          <h1 id="access-heading">{access.status === "forbidden" ? "Team access required." : "We couldn’t verify your access."}</h1>
          <p>{access.status === "forbidden" ? "Your Whop account is no longer on the Loudr Media team. Sign in with a team member account to build proposals." : "Access verification is temporarily unavailable. Try again shortly."}</p>
          {access.status === "forbidden" ? <form action="/api/auth/logout" method="post"><button type="submit" className="primary-button">Sign in again</button></form> : <a className="primary-button" href="/team">Try again</a>}
        </section>}
      </main>
      <footer className="site-footer"><span>© {new Date().getFullYear()} LOUDR Media</span><span>Team proposals</span></footer>
    </div>
  );
}
