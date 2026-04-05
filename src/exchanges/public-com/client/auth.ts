// Auth token manager for Public.com API
// Adapted from github.com/Gajesh2007/public-com-mcp

const BASE_URL = 'https://api.public.com';

interface TokenResponse {
  accessToken: string;
}

export class AuthManager {
  private apiSecretKey: string;
  private validityMinutes: number;
  private accessToken: string | null = null;
  private tokenExpiresAt: number | null = null;

  constructor(apiSecretKey: string, validityMinutes: number = 15) {
    if (validityMinutes < 5 || validityMinutes > 1440) {
      throw new Error('Validity must be between 5 and 1440 minutes');
    }
    this.apiSecretKey = apiSecretKey;
    this.validityMinutes = validityMinutes;
  }

  private isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpiresAt) return false;
    return Date.now() < this.tokenExpiresAt;
  }

  private async createAccessToken(): Promise<void> {
    const response = await fetch(
      `${BASE_URL}/userapiauthservice/personal/access-tokens`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          secret: this.apiSecretKey,
          validityInMinutes: this.validityMinutes,
        }),
      },
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to create access token: ${response.status} - ${errorBody}`);
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.accessToken;

    // Subtract 5 minutes safety buffer
    const expiresInMs = (this.validityMinutes - 5) * 60 * 1000;
    this.tokenExpiresAt = Date.now() + expiresInMs;
  }

  async getAccessToken(): Promise<string> {
    if (!this.isTokenValid()) {
      await this.createAccessToken();
    }
    return this.accessToken!;
  }

  revokeToken(): void {
    this.accessToken = null;
    this.tokenExpiresAt = null;
  }
}
