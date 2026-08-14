import { Bookmark, Search, Sparkles } from "lucide-react";
import Link from "next/link";

import { signInAction, signUpAction } from "@/app/auth/actions";
import { SubmitButton } from "@/components/submit-button";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; message?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  return (
    <main className="login-page">
      <section className="login-story">
        <Link className="brand brand-large" href="/" aria-label="SaveSort home">
          <span className="brand-mark">S</span>
          <span>SaveSort</span>
          <i aria-hidden="true">*</i>
        </Link>
        <div>
          <h1>Find the thing you saved.</h1>
          <p>
            One private place for repositories, articles, videos, tools, and the
            links you swear you&apos;ll remember later.
          </p>
          <ul className="login-benefits">
            <li>
              <Search size={19} /> Search with exact words or a vague memory
            </li>
            <li>
              <Bookmark size={19} /> Save any public URL in a few seconds
            </li>
            <li>
              <Sparkles size={19} /> Keep keyword search even when AI is
              unavailable
            </li>
          </ul>
        </div>
      </section>

      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-card">
          <span className="mobile-login-brand">SaveSort*</span>
          <h2 id="login-title">Welcome back</h2>
          <p>Create an account or sign in with your email and password.</p>
          {params.error ? (
            <div className="notice notice-error">{params.error}</div>
          ) : null}
          {params.message ? (
            <div className="notice notice-success">{params.message}</div>
          ) : null}
          <form action={signInAction} className="auth-form">
            <label>
              Email
              <input
                name="email"
                type="email"
                autoComplete="email"
                required
                placeholder="you@example.com"
              />
            </label>
            <label>
              Password
              <input
                name="password"
                type="password"
                autoComplete="current-password"
                minLength={8}
                required
                placeholder="At least 8 characters"
              />
            </label>
            <div className="auth-actions">
              <SubmitButton>Sign in</SubmitButton>
              <button
                className="button button-secondary"
                formAction={signUpAction}
              >
                Create account
              </button>
            </div>
          </form>
        </div>
      </section>
    </main>
  );
}
