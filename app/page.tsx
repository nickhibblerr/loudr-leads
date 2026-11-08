import Brand from "@/components/Brand";
import TopUp from "@/components/TopUp";
import ThemeToggle from "@/components/ThemeToggle";
import "./admin/admin.css";

export default function Home() {
  return (
    <div className="site-shell">
      <a href="#top-up" className="skip-link">Skip to lead selection</a>
      <header className="site-header">
        <Brand />
        <nav className="site-header-actions" aria-label="Main navigation">
          <span className="header-note"><span className="status-dot" /> Client lead orders</span>
          <a className="admin-entry-button" href="/admin">Admin</a>
          <ThemeToggle />
        </nav>
      </header>

      <main className="main-grid">
        <section className="intro" aria-labelledby="page-heading">
          <div className="intro-copy">
            <p className="eyebrow"><span className="eyebrow-line" /> Turn up your pipeline</p>
            <h1 id="page-heading">More leads.<br /> More opportunity<span className="accent-text">.</span></h1>
            <p className="intro-description">
              Make your next move louder. Choose your lead volume and give your team more opportunities to start the right conversations.
            </p>
            <div className="intro-detail"><span className="detail-line" /> Build your pipeline. Make every conversation count.</div>
          </div>
          <p className="settlement-note">
            Start with a volume that fits your team. Consistent follow-up helps you make the most of every lead.
          </p>
        </section>

        <section id="top-up" className="top-up-region" aria-label="Choose your lead quantity">
          <TopUp />
        </section>
      </main>

      <footer className="site-footer">
        <span>© {new Date().getFullYear()} LOUDR Media</span>
        <span>Built for your next level.</span>
      </footer>
    </div>
  );
}
