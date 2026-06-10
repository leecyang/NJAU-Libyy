export type CasAttemptPurpose = "INITIAL_BIND" | "REBIND" | "AUTO_RECOVERY";
export type CasAttemptStatus = "QUEUED" | "RUNNING" | "SMS_REQUIRED" | "SUCCEEDED" | "FAILED" | "EXPIRED";

export type CasAttemptPublic = {
  attemptId: string;
  status: CasAttemptStatus;
  purpose: CasAttemptPurpose;
  progress: string;
  smsExpiresAt: number | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export interface CasAutomationAdapter {
  initialize(): Promise<void>;
  startAttempt(userId: string, studentId: string, password: string, purpose: CasAttemptPurpose): Promise<CasAttemptPublic>;
  startRecovery(userId: string): Promise<CasAttemptPublic | null>;
  submitSms(userId: string, attemptId: string, code: string): Promise<CasAttemptPublic>;
  removeUser(userId: string): Promise<void>;
}
