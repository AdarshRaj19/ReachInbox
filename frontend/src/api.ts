const API_BASE_URL = "https://reachinbox-backend-kj0q.onrender.com";
const credentials: RequestCredentials = "include";
export async function checkBackend() {
  const response = await fetch(`${API_BASE_URL}/health`, {
    credentials,
  });
  if (!response.ok) {
    throw new Error("Backend request failed");
  }
  return response.json();
}
export async function getEmails() {
  const response = await fetch(`${API_BASE_URL}/api/emails`, {
    credentials,
  });
  if (!response.ok) {
    throw new Error("Failed to fetch emails");
  }
  return response.json();
}
export async function createCampaign(formData: FormData) {
  const response = await fetch(`${API_BASE_URL}/api/campaigns`, {
    method: "POST",
    body: formData,
    credentials,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to create campaign");
  }
  return data;
}
export function startGoogleLogin() {
  window.location.href = `${API_BASE_URL}/auth/google`;
}
export async function getCurrentUser() {
  const response = await fetch(`${API_BASE_URL}/auth/me`, {
    credentials,
  });
  if (response.status === 401) {
    return null;
  }
  if (!response.ok) {
    throw new Error("Failed to fetch current user");
  }
  const data = await response.json();
  return data.user;
}
export async function logout() {
  const response = await fetch(`${API_BASE_URL}/auth/logout`, {
    method: "POST",
    credentials,
  });
  if (!response.ok) {
    throw new Error("Logout failed");
  }
  return response.json();
}
