"use client";

import { useState, useEffect, useMemo } from "react";
import { useSession } from "next-auth/react";
import {
  ShieldCheck,
  ShieldOff,
  QrCode,
  KeyRound,
  Copy,
  CheckCircle,
  Loader2,
  Eye,
  EyeOff,
} from "lucide-react";
import AdminLayoutNew from "@/components/admin/AdminLayoutNew";
import { showSuccessToast, showErrorToast } from "@/lib/toast";

type Step = "status" | "scan" | "verify" | "backup" | "disable";

export default function AdminSecurityPage() {
  const { data: session } = useSession();
  const user = useMemo(
    () =>
      session?.user
        ? {
            firstName: session.user.name?.split(" ")[0] || "",
            lastName: session.user.name?.split(" ").slice(1).join(" ") || "",
            role: (session.user as any).role || "admin",
          }
        : null,
    [session]
  );
  const [totpEnabled, setTotpEnabled] = useState<boolean | null>(null);
  const [step, setStep] = useState<Step>("status");
  const [isLoading, setIsLoading] = useState(false);

  // Setup state
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState("");
  const [manualKey, setManualKey] = useState("");
  const [showManualKey, setShowManualKey] = useState(false);
  const [verifyCode, setVerifyCode] = useState("");
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  // Disable state
  const [disableCode, setDisableCode] = useState("");
  const [disablePassword, setDisablePassword] = useState("");
  const [showDisablePassword, setShowDisablePassword] = useState(false);

  useEffect(() => {
    fetch("/api/auth/totp/setup")
      .then((r) => r.json())
      .then((d) => setTotpEnabled(d.totpEnabled ?? false))
      .catch(() => setTotpEnabled(false));
  }, []);

  async function handleStartSetup() {
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/totp/setup", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Setup failed");
      setQrCodeDataUrl(data.qrCodeDataUrl);
      setManualKey(data.manualKey);
      setStep("scan");
    } catch (e: any) {
      showErrorToast(e.message);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleConfirm() {
    if (verifyCode.length !== 6) {
      showErrorToast("Enter the 6-digit code from your app");
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/totp/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: verifyCode }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Verification failed");
      setBackupCodes(data.backupCodes);
      setTotpEnabled(true);
      setStep("backup");
    } catch (e: any) {
      showErrorToast(e.message);
      setVerifyCode("");
    } finally {
      setIsLoading(false);
    }
  }

  async function handleDisable() {
    if (!disableCode || !disablePassword) {
      showErrorToast("Both fields are required");
      return;
    }
    setIsLoading(true);
    try {
      const res = await fetch("/api/auth/totp/disable", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: disableCode, password: disablePassword }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Could not disable 2FA");
      setTotpEnabled(false);
      setStep("status");
      setDisableCode("");
      setDisablePassword("");
      showSuccessToast("Two-factor authentication disabled");
    } catch (e: any) {
      showErrorToast(e.message);
    } finally {
      setIsLoading(false);
    }
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text).then(() =>
      showSuccessToast("Copied to clipboard")
    );
  }

  return (
    <AdminLayoutNew user={user}>
      <div className="max-w-xl mx-auto py-10 px-4">
        <div className="mb-8">
          <h1 className="text-2xl font-bold text-gray-900">Account Security</h1>
          <p className="text-sm text-gray-500 mt-1">
            Manage two-factor authentication for your admin account.
          </p>
        </div>

        {/* Status panel */}
        {step === "status" && (
          <div className="rounded-xl border bg-white shadow-sm overflow-hidden">
            <div className="p-6 flex items-start gap-4">
              <div
                className={`rounded-full p-3 ${
                  totpEnabled
                    ? "bg-green-100 text-green-600"
                    : "bg-gray-100 text-gray-400"
                }`}
              >
                {totpEnabled ? (
                  <ShieldCheck className="h-6 w-6" />
                ) : (
                  <ShieldOff className="h-6 w-6" />
                )}
              </div>
              <div className="flex-1">
                <p className="font-semibold text-gray-900">
                  Two-factor authentication
                </p>
                <p className="text-sm text-gray-500 mt-0.5">
                  {totpEnabled === null
                    ? "Loading…"
                    : totpEnabled
                    ? "Active — your account requires an authenticator code at login."
                    : "Not configured — add an extra layer of security to your account."}
                </p>
              </div>
            </div>
            <div className="border-t px-6 py-4 flex gap-3">
              {totpEnabled === null ? (
                <Loader2 className="h-4 w-4 animate-spin text-gray-400" />
              ) : totpEnabled ? (
                <button
                  onClick={() => setStep("disable")}
                  className="text-sm font-medium text-red-600 hover:text-red-700"
                >
                  Disable 2FA
                </button>
              ) : (
                <button
                  onClick={handleStartSetup}
                  disabled={isLoading}
                  className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {isLoading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <QrCode className="h-4 w-4" />
                  )}
                  Set up 2FA
                </button>
              )}
            </div>
          </div>
        )}

        {/* Step: Scan QR code */}
        {step === "scan" && (
          <div className="rounded-xl border bg-white shadow-sm p-6 space-y-5">
            <h2 className="font-semibold text-gray-900">
              Step 1 — Scan the QR code
            </h2>
            <p className="text-sm text-gray-600">
              Open your authenticator app (Google Authenticator, Authy, 1Password,
              etc.) and scan the code below.
            </p>

            {qrCodeDataUrl && (
              <div className="flex justify-center">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={qrCodeDataUrl} alt="TOTP QR code" className="rounded border p-2" />
              </div>
            )}

            <div className="rounded-lg bg-gray-50 border p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium text-gray-500 flex items-center gap-1">
                  <KeyRound className="h-3 w-3" /> Manual entry key
                </span>
                <button
                  onClick={() => setShowManualKey(!showManualKey)}
                  className="text-xs text-gray-400 hover:text-gray-600"
                >
                  {showManualKey ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </button>
              </div>
              {showManualKey ? (
                <div className="flex items-center gap-2">
                  <code className="text-xs font-mono break-all text-gray-800">
                    {manualKey}
                  </code>
                  <button onClick={() => copyToClipboard(manualKey)}>
                    <Copy className="h-3.5 w-3.5 text-gray-400 hover:text-gray-600 shrink-0" />
                  </button>
                </div>
              ) : (
                <p className="text-xs text-gray-400 italic">Hidden — click eye to reveal</p>
              )}
            </div>

            <button
              onClick={() => setStep("verify")}
              className="w-full rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
            >
              I've scanned the code →
            </button>
          </div>
        )}

        {/* Step: Verify code */}
        {step === "verify" && (
          <div className="rounded-xl border bg-white shadow-sm p-6 space-y-5">
            <h2 className="font-semibold text-gray-900">
              Step 2 — Verify the code
            </h2>
            <p className="text-sm text-gray-600">
              Enter the 6-digit code your authenticator app shows to confirm setup.
            </p>
            <input
              type="text"
              inputMode="numeric"
              placeholder="000000"
              value={verifyCode}
              onChange={(e) =>
                setVerifyCode(e.target.value.replace(/\D/g, "").slice(0, 6))
              }
              maxLength={6}
              className="w-full rounded-lg border px-4 py-2.5 text-center text-2xl font-mono tracking-[0.4em] focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />
            <div className="flex gap-3">
              <button
                onClick={() => setStep("scan")}
                className="flex-1 rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                ← Back
              </button>
              <button
                onClick={handleConfirm}
                disabled={isLoading || verifyCode.length !== 6}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Verify & enable
              </button>
            </div>
          </div>
        )}

        {/* Step: Backup codes */}
        {step === "backup" && (
          <div className="rounded-xl border bg-white shadow-sm p-6 space-y-5">
            <div className="flex items-center gap-3">
              <CheckCircle className="h-6 w-6 text-green-500 shrink-0" />
              <div>
                <h2 className="font-semibold text-gray-900">
                  2FA enabled successfully
                </h2>
                <p className="text-sm text-gray-500">
                  Save your backup codes now — they won't be shown again.
                </p>
              </div>
            </div>

            <div className="rounded-lg bg-amber-50 border border-amber-200 p-4">
              <p className="text-xs font-medium text-amber-800 mb-3">
                Each backup code can only be used once. Store them securely.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {backupCodes.map((code) => (
                  <code
                    key={code}
                    className="text-xs font-mono bg-white border rounded px-2 py-1.5 text-center"
                  >
                    {code}
                  </code>
                ))}
              </div>
              <button
                onClick={() => copyToClipboard(backupCodes.join("\n"))}
                className="mt-3 inline-flex items-center gap-1.5 text-xs text-amber-700 hover:text-amber-900"
              >
                <Copy className="h-3.5 w-3.5" /> Copy all codes
              </button>
            </div>

            <button
              onClick={() => setStep("status")}
              className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-800"
            >
              Done
            </button>
          </div>
        )}

        {/* Disable 2FA */}
        {step === "disable" && (
          <div className="rounded-xl border bg-white shadow-sm p-6 space-y-5">
            <h2 className="font-semibold text-gray-900">Disable 2FA</h2>
            <p className="text-sm text-gray-600">
              Enter your current authenticator code and account password to
              confirm.
            </p>

            <div className="space-y-3">
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Authenticator code
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  placeholder="000000"
                  value={disableCode}
                  onChange={(e) =>
                    setDisableCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                  }
                  maxLength={6}
                  className="w-full rounded-lg border px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-700 mb-1">
                  Account password
                </label>
                <div className="relative">
                  <input
                    type={showDisablePassword ? "text" : "password"}
                    placeholder="Your password"
                    value={disablePassword}
                    onChange={(e) => setDisablePassword(e.target.value)}
                    className="w-full rounded-lg border px-4 py-2.5 text-sm pr-10 focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button
                    type="button"
                    onClick={() => setShowDisablePassword(!showDisablePassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                  >
                    {showDisablePassword ? (
                      <EyeOff className="h-4 w-4" />
                    ) : (
                      <Eye className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="flex gap-3">
              <button
                onClick={() => setStep("status")}
                className="flex-1 rounded-lg border px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={handleDisable}
                disabled={isLoading}
                className="flex-1 inline-flex items-center justify-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
              >
                {isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
                Disable 2FA
              </button>
            </div>
          </div>
        )}
      </div>
    </AdminLayoutNew>
  );
}
