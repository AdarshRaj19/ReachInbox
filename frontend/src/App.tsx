
import { useEffect, useState } from "react";
import { checkBackend, getEmails, createCampaign, startGoogleLogin, getCurrentUser, logout } from "./api";

type Email = {
  id: string;
  recipient_email: string;
  subject: string;
  scheduled_at: string;
  sent_at: string | null;
  status: string;
};

type EmailTab = "scheduled" | "sent";
type CurrentUser = {
  id: string;
  email: string;
  display_name: string | null;
  avatar_url: string | null;
};

function App() {
  const [backendStatus, setBackendStatus] = useState("Checking...");
  const [currentUser, setCurrentUser] = useState<CurrentUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [authError, setAuthError] = useState("");
  const [emails, setEmails] = useState<Email[]>([]);
  const [activeTab, setActiveTab] = useState<EmailTab>("scheduled");
  const [showCompose, setShowCompose] = useState(false);
  const [loading, setLoading] = useState(true);
  const [emailError, setEmailError] = useState("");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [leadFile, setLeadFile] = useState<File | null>(null);
  const [startTime, setStartTime] = useState("");
  const [delaySeconds, setDelaySeconds] = useState(5);
  const [hourlyLimit, setHourlyLimit] = useState(100);
  const [submitting, setSubmitting] = useState(false);
  const [campaignMessage, setCampaignMessage] = useState("");
  const [detectedEmailCount, setDetectedEmailCount] = useState<number | null>(
    null
  );

  const selectedFileName = leadFile?.name ?? "";

  const refreshEmails = async () => {
    const data: Email[] = await getEmails();
    setEmails(data);
    setEmailError("");
  };

  useEffect(() => {
    getCurrentUser()
      .then((user) => setCurrentUser(user))
      .catch(() => setAuthError("Could not check Google login status."))
      .finally(() => setAuthLoading(false));
    checkBackend()
      .then(() => setBackendStatus("Connected"))
      .catch(() => setBackendStatus("Disconnected"));

    refreshEmails()
      .catch(() => {
        setEmailError("Failed to load emails. Please check the backend.");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const scheduledEmails = emails.filter(
    (email) => email.status === "scheduled" || email.status === "queued"
  );

  const sentEmails = emails.filter((email) => email.status === "sent");

  const scheduledCount = scheduledEmails.length;
  const sentCount = sentEmails.length;

  const visibleEmails = activeTab === "scheduled" ? scheduledEmails : sentEmails;

  // Preview unique email addresses in the selected CSV/TXT file.
  const handleFileChange = async (file: File | null) => {
    setLeadFile(file);
    setDetectedEmailCount(null);
    setCampaignMessage("");

    if (!file) return;

    const filename = file.name.toLowerCase();

    if (!filename.endsWith(".csv") && !filename.endsWith(".txt")) {
      setCampaignMessage("Please select a CSV or TXT file.");
      setLeadFile(null);
      return;
    }

    if (file.size > 2 * 1024 * 1024) {
      setCampaignMessage("File size must not exceed 2 MB.");
      setLeadFile(null);
      return;
    }

    try {
      const content = await file.text();
      const matches =
        content.match(
          /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+/g
        ) ?? [];

      const uniqueEmails = new Set(
        matches
          .map((email) => email.toLowerCase())
          .filter((email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      );

      setDetectedEmailCount(uniqueEmails.size);

      if (uniqueEmails.size === 0) {
        setCampaignMessage("No valid email addresses detected in this file.");
      }
    } catch {
      setCampaignMessage("Could not read the selected file.");
    }
  };

  const handleScheduleCampaign = async () => {
    if (!subject.trim() || !body.trim() || !leadFile || !startTime) {
      setCampaignMessage(
        "Please enter the subject, body, leads file, and start time."
      );
      return;
    }

    if (
      !Number.isInteger(delaySeconds) ||
      delaySeconds < 0 ||
      !Number.isInteger(hourlyLimit) ||
      hourlyLimit < 1
    ) {
      setCampaignMessage("Please enter valid delay and hourly limit values.");
      return;
    }

    if (detectedEmailCount === 0) {
      setCampaignMessage("Please upload a file containing valid email addresses.");
      return;
    }

    const selectedStartTime = new Date(startTime);

    if (
      Number.isNaN(selectedStartTime.getTime()) ||
      selectedStartTime.getTime() < Date.now()
    ) {
      setCampaignMessage(
        "Please select a start time that is now or in the future."
      );
      return;
    }

    const formData = new FormData();
    formData.append("subject", subject.trim());
    formData.append("body", body.trim());
    formData.append("startTime", selectedStartTime.toISOString());
    formData.append("delaySeconds", String(delaySeconds));
    formData.append("hourlyLimit", String(hourlyLimit));
    formData.append("file", leadFile);

    try {
      setSubmitting(true);
      setCampaignMessage("");

      const result = await createCampaign(formData);

      setCampaignMessage(
        `${result.message || "Campaign scheduled successfully."} Recipients: ${
          result.recipientCount ?? detectedEmailCount ?? "—"
        }.`
      );

      await refreshEmails();
      setActiveTab("scheduled");

      setSubject("");
      setBody("");
      setLeadFile(null);
      setDetectedEmailCount(null);
      setStartTime("");
      setShowCompose(false);
    } catch (error) {
      setCampaignMessage(
        error instanceof Error ? error.message : "Request failed."
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <aside className="border-b border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold">ReachInbox</h1>
            <p className="mt-1 text-sm text-slate-500">
              Email scheduling dashboard
            </p>
          </div>
          {authLoading ? (
            <p className="text-sm text-slate-500">Checking login...</p>
          ) : currentUser ? (
            <div className="flex items-center gap-3">
              {currentUser.avatar_url && (
                <img
                  src={currentUser.avatar_url}
                  alt="Profile"
                  className="h-10 w-10 rounded-full"
                />
              )}
              <div>
                <p className="text-sm font-semibold">
                  {currentUser.display_name || currentUser.email}
                </p>
                <p className="text-xs text-slate-500">{currentUser.email}</p>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await logout();
                    setCurrentUser(null);
                    setAuthError("");
                  } catch {
                    setAuthError("Logout failed. Please try again.");
                  }
                }}
                className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
              >
                Logout
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={startGoogleLogin}
              className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
            >
              Continue with Google
            </button>
          )}
        </div>
        {authError && (
          <p className="mt-2 text-sm text-red-600" role="alert">
            {authError}
          </p>
        )}
      </aside>

      <main className="mx-auto max-w-6xl p-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-2xl font-semibold">Email Dashboard</h2>
            <p className="mt-1 text-slate-500">
              Manage your scheduled and sent emails.
            </p>

            <p className="mt-2 text-sm text-slate-500">
              Backend:{" "}
              <span
                className={
                  backendStatus === "Connected"
                    ? "font-medium text-green-600"
                    : backendStatus === "Disconnected"
                      ? "font-medium text-red-600"
                      : "font-medium"
                }
              >
                {backendStatus}
              </span>
            </p>
          </div>

          <button
            type="button"
            onClick={() => setShowCompose(true)}
            className="rounded-lg bg-blue-600 px-4 py-2 font-medium text-white hover:bg-blue-700"
          >
            Compose Email
          </button>
        </div>

        {showCompose && (
          <section className="mt-6 rounded-xl border border-slate-200 bg-white p-5">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Compose Email</h3>
              <button
                type="button"
                onClick={() => setShowCompose(false)}
                className="text-sm text-slate-500 hover:text-slate-900"
              >
                Cancel
              </button>
            </div>

            <div className="mt-5 grid gap-4">
              <label className="grid gap-1 text-sm font-medium">
                Email Subject
                <input
                  type="text"
                  value={subject}
                  onChange={(event) => setSubject(event.target.value)}
                  placeholder="Enter email subject"
                  className="rounded-lg border border-slate-300 p-3 font-normal"
                />
              </label>

              <label className="grid gap-1 text-sm font-medium">
                Email Body
                <textarea
                  rows={5}
                  value={body}
                  onChange={(event) => setBody(event.target.value)}
                  placeholder="Write your email message..."
                  className="rounded-lg border border-slate-300 p-3 font-normal"
                />
              </label>

              <label className="grid gap-1 text-sm font-medium">
                Upload Leads (CSV or TXT)
                <input
                  type="file"
                  accept=".csv,.txt,text/plain,text/csv"
                  onChange={(event) =>
                    handleFileChange(event.target.files?.[0] ?? null)
                  }
                  className="rounded-lg border border-slate-300 p-3 font-normal"
                />

                {selectedFileName && (
                  <p className="text-sm text-slate-500">
                    Selected file: {selectedFileName}
                  </p>
                )}

                {detectedEmailCount !== null && (
                  <p className="text-sm font-medium text-blue-700">
                    Detected unique email addresses: {detectedEmailCount}
                  </p>
                )}
              </label>

              <label className="grid gap-1 text-sm font-medium">
                Campaign Start Time
                <input
                  type="datetime-local"
                  value={startTime}
                  min={new Date(
                    Date.now() - new Date().getTimezoneOffset() * 60000
                  )
                    .toISOString()
                    .slice(0, 16)}
                  onChange={(event) => setStartTime(event.target.value)}
                  className="rounded-lg border border-slate-300 p-3 font-normal"
                />
              </label>

              <div className="grid gap-4 sm:grid-cols-2">
                <label className="grid gap-1 text-sm font-medium">
                  Delay Between Emails (seconds)
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={delaySeconds}
                    onChange={(event) =>
                      setDelaySeconds(Number(event.target.value))
                    }
                    className="rounded-lg border border-slate-300 p-3 font-normal"
                  />
                </label>

                <label className="grid gap-1 text-sm font-medium">
                  Hourly Sending Limit
                  <input
                    type="number"
                    min="1"
                    step="1"
                    value={hourlyLimit}
                    onChange={(event) =>
                      setHourlyLimit(Number(event.target.value))
                    }
                    className="rounded-lg border border-slate-300 p-3 font-normal"
                  />
                </label>
              </div>

              <button
                type="button"
                onClick={handleScheduleCampaign}
                disabled={submitting}
                className="rounded-lg bg-blue-600 px-4 py-3 font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {submitting ? "Submitting..." : "Schedule Campaign"}
              </button>

              {campaignMessage && (
                <p className="text-sm text-slate-600" role="status">
                  {campaignMessage}
                </p>
              )}
            </div>
          </section>
        )}

        <section className="mt-8 grid gap-4 sm:grid-cols-3">
          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Scheduled Emails</p>
            <p className="mt-2 text-3xl font-bold">
              {loading ? "..." : scheduledCount}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Sent Emails</p>
            <p className="mt-2 text-3xl font-bold">
              {loading ? "..." : sentCount}
            </p>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-5">
            <p className="text-sm text-slate-500">Hourly Sending Limit</p>
            <p className="mt-2 text-3xl font-bold">{hourlyLimit}</p>
            <p className="mt-1 text-xs text-slate-500">
              Limit for the next campaign
            </p>
          </div>
        </section>

        <section className="mt-8 rounded-xl border border-slate-200 bg-white p-5">
          <h3 className="text-lg font-semibold">Your Emails</h3>

          <div className="mt-4 flex gap-2 border-b border-slate-200">
            <button
              type="button"
              onClick={() => setActiveTab("scheduled")}
              className={`border-b-2 px-4 py-3 text-sm font-medium ${
                activeTab === "scheduled"
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-900"
              }`}
              aria-pressed={activeTab === "scheduled"}
            >
              Scheduled ({scheduledCount})
            </button>

            <button
              type="button"
              onClick={() => setActiveTab("sent")}
              className={`border-b-2 px-4 py-3 text-sm font-medium ${
                activeTab === "sent"
                  ? "border-blue-600 text-blue-700"
                  : "border-transparent text-slate-500 hover:text-slate-900"
              }`}
              aria-pressed={activeTab === "sent"}
            >
              Sent ({sentCount})
            </button>
          </div>

          {loading ? (
            <p className="mt-3 text-sm text-slate-500">Loading emails...</p>
          ) : emailError ? (
            <p className="mt-3 text-sm text-red-600">{emailError}</p>
          ) : visibleEmails.length === 0 ? (
            <p className="mt-3 text-sm text-slate-500">
              {activeTab === "scheduled"
                ? "No scheduled emails. New campaigns will appear here."
                : "No sent emails found."}
            </p>
          ) : (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead>
                  <tr className="border-b border-slate-200 text-slate-500">
                    <th className="p-3">Recipient</th>
                    <th className="p-3">Subject</th>
                    <th className="p-3">Status</th>
                    <th className="p-3">Scheduled At</th>
                  </tr>
                </thead>

                <tbody>
                  {visibleEmails.map((email) => (
                    <tr key={email.id} className="border-b border-slate-100">
                      <td className="p-3">{email.recipient_email}</td>
                      <td className="p-3">{email.subject}</td>
                      <td className="p-3">
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-medium ${
                            email.status === "sent"
                              ? "bg-green-100 text-green-700"
                              : "bg-blue-100 text-blue-700"
                          }`}
                        >
                          {email.status}
                        </span>
                      </td>
                      <td className="p-3">
                        {new Date(email.scheduled_at).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}

export default App;



