import { SqlModel, type SqlDocument } from "./SqlModel.ts";
export interface LoginChallenge {
  challenge_id: string;
  user_id: string;
  credential_id: string;
  device_id: string;
  nonce_hash: string;
  created_at: Date;
  expires_at: Date;
  consumed_at?: Date | null;
}
export type LoginChallengeDocument = SqlDocument<LoginChallenge>;
export default new SqlModel<LoginChallenge>("login_challenges", `challenge_id user_id credential_id
  device_id nonce_hash created_at expires_at consumed_at`);
