import { useState } from "react";
import { describeAccountError, validateAccountForm } from "../../lib/accountView.js";

// Sign in / Create account / Recover (decisions H6-2, H6-3, H6-27). Passwords
// live only in this component's state while the form is open: they are sent
// to the engine and never stored, logged or shown.

const AUTH_MODES = [
  { id: "signIn", label: "Sign in" },
  { id: "signUp", label: "Create account" },
];

function AccountTextInput({ id, label, hint, ...inputProps }) {
  return (
    <label htmlFor={id} className="block">
      <span className="label mb-2 block">{label}</span>
      <input id={id} className="focus-ring field min-h-11 w-full" {...inputProps} />
      {hint && <span className="mt-1 block text-xs font-medium text-text-3">{hint}</span>}
    </label>
  );
}

export default function AccountAuthForms({ engine, initialUsername = "", onSignedIn }) {
  const [mode, setMode] = useState("signIn");
  const [values, setValues] = useState({
    username: initialUsername,
    password: "",
    confirmPassword: "",
    newPassword: "",
    inviteCode: "",
    recoveryCode: "",
  });
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  function update(field) {
    return (event) => {
      const { value } = event.target;
      setValues((current) => ({ ...current, [field]: value }));
    };
  }

  function switchMode(nextMode) {
    setMode(nextMode);
    setError("");
    setValues((current) => ({ ...current, password: "", confirmPassword: "", newPassword: "", recoveryCode: "" }));
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (pending) {
      return;
    }

    const checked = validateAccountForm(mode, values);

    if (!checked.ok) {
      setError(checked.error);
      return;
    }

    setError("");
    setPending(true);
    let result;

    try {
      result =
        mode === "signUp"
          ? await engine.signUp(checked.values)
          : mode === "recover"
            ? await engine.recover(checked.values)
            : await engine.signIn(checked.values);
    } catch {
      result = { ok: false, error: { kind: "server", code: "internal" } };
    }

    setPending(false);

    if (!result?.ok) {
      setError(describeAccountError(result?.error));
      return;
    }

    setValues((current) => ({ ...current, password: "", confirmPassword: "", newPassword: "", recoveryCode: "", inviteCode: "" }));
    onSignedIn?.({ mode, recoveryCode: result.recoveryCode ?? null });
  }

  const submitLabel = mode === "signUp" ? "Create account" : mode === "recover" ? "Set new password" : "Sign in";

  return (
    <div className="mt-4">
      {mode !== "recover" ? (
        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Account form">
          {AUTH_MODES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={mode === item.id}
              onClick={() => switchMode(item.id)}
              className={`focus-ring btn min-h-11 px-3 text-sm ${mode === item.id ? "btn-primary" : "btn-secondary"}`}
            >
              {item.label}
            </button>
          ))}
        </div>
      ) : (
        <div>
          <p className="text-sm font-semibold text-text-1">Recover your account</p>
          <p className="mt-1 text-sm leading-6 text-text-2">
            Enter your username, the recovery code you saved when you created the account, and a new password.
            Other devices are signed out.
          </p>
        </div>
      )}

      <form className="mt-4 space-y-3" onSubmit={handleSubmit} noValidate>
        <AccountTextInput
          id="account-username"
          label="Username"
          name="username"
          type="text"
          autoComplete="username"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          value={values.username}
          onChange={update("username")}
          hint={mode === "signUp" ? "3 to 32 characters: lower-case letters, digits, dots, dashes or underscores." : ""}
        />

        {mode === "recover" ? (
          <AccountTextInput
            id="account-recovery-code"
            label="Recovery code"
            name="recoveryCode"
            type="text"
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            value={values.recoveryCode}
            onChange={update("recoveryCode")}
          />
        ) : (
          <AccountTextInput
            id="account-password"
            label="Password"
            name="password"
            type="password"
            autoComplete={mode === "signUp" ? "new-password" : "current-password"}
            value={values.password}
            onChange={update("password")}
            hint={mode === "signUp" ? "At least 10 characters." : ""}
          />
        )}

        {mode === "recover" && (
          <AccountTextInput
            id="account-new-password"
            label="New password"
            name="newPassword"
            type="password"
            autoComplete="new-password"
            value={values.newPassword}
            onChange={update("newPassword")}
            hint="At least 10 characters."
          />
        )}

        {(mode === "signUp" || mode === "recover") && (
          <AccountTextInput
            id="account-confirm-password"
            label={mode === "signUp" ? "Repeat password" : "Repeat new password"}
            name="confirmPassword"
            type="password"
            autoComplete="new-password"
            value={values.confirmPassword}
            onChange={update("confirmPassword")}
          />
        )}

        {mode === "signUp" && (
          <AccountTextInput
            id="account-invite-code"
            label="Invite code"
            name="inviteCode"
            type="text"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            value={values.inviteCode}
            onChange={update("inviteCode")}
            hint="Needed only when the sync server asks for one."
          />
        )}

        {error && (
          <p role="alert" className="rounded-block bg-bad-tint px-3 py-2 text-sm font-medium text-bad">
            {error}
          </p>
        )}

        <button type="submit" disabled={pending} className="focus-ring btn btn-primary min-h-12 w-full">
          {pending ? "Please wait..." : submitLabel}
        </button>
      </form>

      <div className="mt-3 flex flex-wrap gap-2">
        {mode === "recover" ? (
          <button type="button" onClick={() => switchMode("signIn")} className="focus-ring btn btn-ghost btn-sm min-h-11">
            Back to sign in
          </button>
        ) : (
          <button type="button" onClick={() => switchMode("recover")} className="focus-ring btn btn-ghost btn-sm min-h-11">
            Forgot your password?
          </button>
        )}
      </div>
    </div>
  );
}
