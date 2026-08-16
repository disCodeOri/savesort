import { Bookmark, Search, Sparkles } from "lucide-react";
import Image from "next/image";
import Link from "next/link";

import {
  signInAction,
  signInWithGoogleAction,
  signUpAction,
} from "@/app/auth/actions";
import { SubmitButton } from "@/components/submit-button";

interface LoginPageProps {
  searchParams: Promise<{ error?: string; message?: string }>;
}

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const params = await searchParams;
  return (
    <main className="login-page">
      <section className="login-story">
        <Link className="brand-logo-link brand-large" href="/" aria-label="Grapplin home">
          <Image
            src="/grapplin-logo.png"
            alt="Grapplin"
            width={240}
            height={120}
            className="login-brand-logo"
            priority
          />
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
          <span className="mobile-login-brand">Grapplin*</span>
          <h2 id="login-title">Welcome back</h2>
          <p>Create an account or sign in with your email and password.</p>
          {params.error ? (
            <div className="notice notice-error">{params.error}</div>
          ) : null}
          {params.message ? (
            <div className="notice notice-success">{params.message}</div>
          ) : null}
          <form action={signInWithGoogleAction} className="auth-oauth-form">
            <button
              type="submit"
              className="button button-secondary auth-oauth-button"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                aria-hidden="true"
                className="google-icon"
              >
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z"
                />
              </svg>
              <span>Continue with Google</span>
            </button>
          </form>
          <div className="auth-divider" role="separator" aria-label="Divider">
            <span>or continue with email</span>
          </div>
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
