"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { AVATAR_MAX_BYTES } from "@stellartrust/shared";
import { Avatar } from "@/components/Avatar";
import { CopyableId } from "@/components/CopyableId";
import { Icon } from "@/components/Icon";
import { useIdentity } from "@/components/IdentityProvider";
import { StatusPill } from "@/components/StatusPill";
import { api } from "@/lib/api";

/** Reads a File as a base64 data URL, which is what the upload endpoint takes. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Could not read that file"));
    reader.readAsDataURL(file);
  });
}

export function ProfilePanel() {
  const { session, profile, loading, refreshProfile } = useIdentity();
  const [username, setUsername] = useState("");
  const [savingName, setSavingName] = useState(false);
  const [nameError, setNameError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // There is no route guard in this app (no middleware.ts), so every feature
  // component handles its own signed-out state.
  if (loading) {
    return <div className="panel-dark h-64 animate-pulse rounded-lg" aria-hidden="true" />;
  }
  if (!session || !profile) {
    return (
      <div className="panel-dark p-lg text-center sm:p-xl">
        <h1 className="text-2xl font-bold text-on-dark">Your profile</h1>
        <p className="mx-auto mt-sm max-w-md text-muted-strong">
          Connect your Stellar wallet to view and edit your profile.
        </p>
        <Link href="/" className="btn-primary mt-lg inline-flex">
          Connect wallet <Icon name="arrow-right" className="h-4 w-4" />
        </Link>
      </div>
    );
  }

  const user = profile.user;
  const wallet = profile.wallets[0] ?? session.wallet;
  const canClaimUsername = !user.usernameSetAt;
  // Captured past the guard above, so the handlers below need no assertion.
  const { accessToken } = session;

  async function claimUsername(event: React.FormEvent) {
    event.preventDefault();
    setNameError(null);
    setSavingName(true);
    try {
      await api.updateProfile(accessToken, {
        username: username.trim().toLowerCase(),
      });
      await refreshProfile();
      setUsername("");
    } catch (err) {
      setNameError(err instanceof Error ? err.message : "Could not save that username");
    } finally {
      setSavingName(false);
    }
  }

  async function uploadAvatar(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset immediately so re-picking the same file still fires a change event.
    event.target.value = "";
    if (!file) return;

    setAvatarError(null);
    // Checked here as well as on the server so an oversized file fails
    // instantly instead of after uploading megabytes.
    if (file.size > AVATAR_MAX_BYTES) {
      setAvatarError("Image must be 2 MB or smaller");
      return;
    }

    setUploading(true);
    try {
      await api.uploadAvatar(accessToken, await readAsDataUrl(file));
      await refreshProfile();
    } catch (err) {
      setAvatarError(err instanceof Error ? err.message : "Could not upload that image");
    } finally {
      setUploading(false);
    }
  }

  return (
    <div>
      <section className="border-b border-hairline-dark pb-lg sm:pb-xl">
        <p className="eyebrow">Account</p>
        <h1 className="mt-sm text-3xl font-bold tracking-tight text-on-dark sm:text-4xl">
          Your profile
        </h1>
        <p className="mt-sm max-w-2xl leading-7 text-muted-strong">
          Your username and picture are how other people recognise you on the
          orders you share with them.
        </p>
      </section>

      <div className="mt-xl grid items-start gap-lg xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid gap-lg">
          {/* ── Picture ─────────────────────────────────────────────────── */}
          <section className="panel-dark p-lg">
            <h2 className="text-lg font-semibold text-on-dark">Profile picture</h2>
            <div className="mt-md flex flex-col items-center gap-md sm:flex-row sm:items-center">
              <Avatar username={user.username} avatarUrl={user.avatarUrl} size="lg" />
              <div className="min-w-0 flex-1 text-center sm:text-left">
                <button
                  type="button"
                  onClick={() => fileRef.current?.click()}
                  disabled={uploading}
                  className="btn-secondary-dark w-full justify-center sm:w-auto"
                >
                  {uploading
                    ? "Uploading…"
                    : user.avatarUrl
                      ? "Change picture"
                      : "Upload a picture"}
                </button>
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  onChange={(event) => void uploadAvatar(event)}
                  className="hidden"
                />
                <p className="mt-sm text-xs leading-5 text-muted">
                  PNG, JPEG, or WebP, up to 2 MB. Without one, your initials are
                  shown instead.
                </p>
              </div>
            </div>
            {avatarError ? (
              <p role="alert" className="mt-md rounded-md border border-status-rejected/30 bg-status-rejected/10 p-sm text-sm text-status-rejected">
                {avatarError}
              </p>
            ) : null}
          </section>

          {/* ── Username ────────────────────────────────────────────────── */}
          <section className="panel-dark p-lg">
            <h2 className="text-lg font-semibold text-on-dark">Username</h2>
            {canClaimUsername ? (
              <>
                <p className="mt-sm text-sm leading-6 text-muted-strong">
                  You are currently{" "}
                  <span className="font-mono text-body">@{user.username}</span>,
                  a name we generated. Choose your own below.
                </p>
                <form onSubmit={(event) => void claimUsername(event)} className="mt-md">
                  <label className="block text-sm font-medium text-body">
                    New username
                    <span className="relative mt-xs flex items-center">
                      <span aria-hidden="true" className="pointer-events-none absolute left-md font-mono text-muted">@</span>
                      <input
                        required
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                        minLength={3}
                        maxLength={20}
                        pattern="[A-Za-z0-9_]{3,20}"
                        placeholder="your_name"
                        className="input input-dark pl-[2.25rem] font-mono"
                      />
                    </span>
                  </label>
                  <p className="mt-xs text-xs leading-5 text-muted">
                    3–20 characters: letters, numbers, and underscores.
                  </p>
                  <p className="mt-md flex items-start gap-xs rounded-md border border-primary/30 bg-primary/10 p-sm text-xs leading-5 text-primary">
                    <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />
                    You can only set this once. It appears on your transactions,
                    so it cannot be changed afterwards.
                  </p>
                  {nameError ? (
                    <p role="alert" className="mt-md rounded-md border border-status-rejected/30 bg-status-rejected/10 p-sm text-sm text-status-rejected">
                      {nameError}
                    </p>
                  ) : null}
                  <button disabled={savingName || !username.trim()} className="btn-primary mt-md w-full justify-center sm:w-auto">
                    {savingName ? "Saving…" : "Claim this username"}
                    <Icon name="arrow-right" className="h-4 w-4" />
                  </button>
                </form>
              </>
            ) : (
              <>
                <p className="mt-sm font-mono text-2xl font-semibold text-on-dark">
                  @{user.username}
                </p>
                <p className="mt-sm flex items-start gap-xs text-xs leading-5 text-muted">
                  <Icon name="lock" className="mt-0.5 h-4 w-4 shrink-0" />
                  Set permanently. Your username appears on your transaction
                  history, so it stays fixed — contact support if it needs to
                  change.
                </p>
              </>
            )}
          </section>
        </div>

        {/* ── Account details ───────────────────────────────────────────── */}
        <aside className="panel-dark p-lg xl:sticky xl:top-24">
          <h2 className="text-lg font-semibold text-on-dark">Account</h2>
          <dl className="mt-md grid gap-md">
            <div className="flex items-center justify-between gap-sm">
              <dt className="data-label">Verification</dt>
              <dd><StatusPill status={user.kycStatus} /></dd>
            </div>
            <div className="flex items-center justify-between gap-sm">
              <dt className="data-label">Member since</dt>
              <dd className="font-mono text-xs text-body">
                {String(user.createdAt).slice(0, 10)}
              </dd>
            </div>
            {user.displayName ? (
              <div className="flex items-center justify-between gap-sm">
                <dt className="data-label">Legal name</dt>
                <dd className="truncate text-sm text-body">{user.displayName}</dd>
              </div>
            ) : null}
            <div>
              <dt className="data-label">Wallet</dt>
              <dd className="mt-xs break-all font-mono text-xs text-body">
                {wallet.stellarPublicKey}
              </dd>
            </div>
          </dl>
          <div className="mt-lg border-t border-hairline-dark pt-md">
            <CopyableId
              label="Your user ID"
              value={user.id}
              hint="Share this with a seller so they can open an order with you."
            />
          </div>
        </aside>
      </div>
    </div>
  );
}
