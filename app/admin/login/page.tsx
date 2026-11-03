import type { Metadata } from "next";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import Brand from "@/components/Brand";
import { authConfigured, getAdminAccess } from "@/lib/admin-auth";
import "../admin.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Sign in | LOUDR Admin", robots: { index: false, follow: false } };

const messages: Record<string, string> = {
  invalid_credentials: "That username or password is incorrect. Please try again.",
  configuration: "Admin sign-in is temporarily unavailable. Please try again shortly.",
  unavailable: "Admin sign-in is temporarily unavailable. Please try again shortly.",
};

export default async function AdminLogin({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const configured = authConfigured();
  const access = await getAdminAccess((await headers()).get("cookie"));
  if (access.status === "authorized") redirect("/admin");
  const params = await searchParams;
  const error = typeof params.error === "string" && Object.prototype.hasOwnProperty.call(messages, params.error) ? messages[params.error] : undefined;
  const accessMessage = !configured || access.status === "unavailable" ? messages.unavailable : undefined;
  return (
    <div className="site-shell admin-shell">
      <a href="#admin-sign-in" className="skip-link">Skip to admin sign-in</a>
      <header className="site-header"><Brand /><a href="/" className="admin-entry-button">Back to checkout</a></header>
      <main id="admin-sign-in" className="admin-auth-main">
        <section className="admin-access-panel" aria-labelledby="sign-in-heading">
          <p className="eyebrow"><span className="eyebrow-line" /> Loudr Media</p>
          <h1 id="sign-in-heading">Admin sign-in<span className="accent-text">.</span></h1>
          <p>Sign in to manage state pricing.</p>
          {(error || accessMessage) && <p className="form-error" role="alert">{error || accessMessage}</p>}
          {configured ? <form action="/api/auth/login" method="post" className="admin-login-form">
            <label htmlFor="admin-username">Username</label>
            <input id="admin-username" name="username" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={128} />
            <label htmlFor="admin-password">Password</label>
            <input id="admin-password" name="password" type="password" autoComplete="current-password" required maxLength={512} />
            <button type="submit" className="primary-button">Sign in</button>
          </form> : <a href="/admin/login" className="admin-secondary">Try again</a>}
        </section>
      </main>
      <footer className="site-footer"><span>© {new Date().getFullYear()} LOUDR Media</span><span>Admin access</span></footer>
    </div>
  );
}
