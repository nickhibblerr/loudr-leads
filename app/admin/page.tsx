import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import AdminPricing from "@/components/AdminPricing";
import { getAdminAccess } from "@/lib/admin-auth";
import "./admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "State pricing | LOUDR Admin", robots: { index: false, follow: false } };

export default async function AdminPage() {
  const access = await getAdminAccess((await headers()).get("cookie"));
  if (access.status === "unauthenticated") redirect("/admin/login");
  const allowed = access.status === "authorized";
  return (
    <div className="site-shell admin-shell">
      <a href="#state-pricing" className="skip-link">Skip to state pricing</a>
      <header className="site-header">
        <Brand />
        <div className="admin-header-actions">
          <a href="/" className="admin-entry-button">Back to checkout</a>
          <form action="/api/auth/logout" method="post"><button type="submit" className="admin-secondary">Sign out</button></form>
        </div>
      </header>
      <main id="state-pricing" className="admin-main">
        <p className="eyebrow"><span className="eyebrow-line" /> Admin</p>
        {allowed ? <>
          <h1>State pricing<span className="accent-text">.</span></h1>
          <p className="admin-intro">Update the price per lead for each state. Saved changes apply to new checkouts.</p>
          <AdminPricing />
        </> : <section className="admin-access-panel" aria-labelledby="access-heading">
          <h1 id="access-heading">{access.status === "forbidden" ? "Admin access required." : "We couldn’t verify your access."}</h1>
          <p>{access.status === "forbidden" ? "Sign in with the admin account to manage lead prices." : "Access verification is temporarily unavailable. Try again shortly."}</p>
          {access.status === "forbidden" ? <form action="/api/auth/logout" method="post"><button type="submit" className="primary-button">Sign in again</button></form> : <a className="primary-button" href="/admin">Try again</a>}
        </section>}
      </main>
      <footer className="site-footer"><span>© {new Date().getFullYear()} LOUDR Media</span><span>Lead pricing</span></footer>
    </div>
  );
}
