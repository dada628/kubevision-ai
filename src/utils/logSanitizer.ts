/**
 * KubeVision AI - synchronous container-log redactor.
 *
 * Runs on the main thread or inside the edge worker. It never allocates a
 * worker, never awaits, and never touches the network: one log line is a
 * handful of linear scans. The markers it writes are the highlight; callers
 * render the plain string and style `[REDACTED_IP]`, `[MASKED_TOKEN]`,
 * `[MASKED_KEY]` and `[REDACTED_EMAIL]` directly.
 *
 * Order is load-bearing. Tokens and DSNs are masked before IPv4, otherwise a
 * JWT's dotted segments or a `user:password@10.x` userinfo could be partially
 * eaten. A second pass over the result is a no-op: none of the markers match
 * a later pattern, so `maskedCount` stays 0.
 */

import { REDACTION_MARKERS, type SanitizedLog } from '@/types/ai';

/** Bearer JWT, including the `Bearer` prefix so it cannot survive as a hint. */
const BEARER_JWT =
  /\b[Bb]earer\s+eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g;

/** Bare JWT whose header is the base64url of a JSON object (`eyJ` === `{"`). */
const BARE_JWT =
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

/**
 * Skip a value that is already one of our markers so a second pass is a no-op.
 * Placed immediately before the secret body.
 */
const NOT_ALREADY_MASKED =
  '(?!\\[(?:MASKED_KEY|MASKED_TOKEN|REDACTED_IP|REDACTED_EMAIL)\\])';

/**
 * `scheme://user:password@` and `scheme://:password@`.
 * The password group stops at `@` or `/`, which is the userinfo grammar.
 */
const URL_USERINFO = new RegExp(
  `([a-z][a-z0-9+.-]*:\\/\\/)([^@/\\s]*):${NOT_ALREADY_MASKED}([^@/\\s]+)@`,
  'gi',
);

/** `password=...` / `pwd=...` through the next whitespace. `&` stays inside the value. */
const PASSWORD_ASSIGNMENT = new RegExp(
  `\\b(password|passwd|pwd)(\\s*[=:]\\s*)${NOT_ALREADY_MASKED}[^\\s'"]+`,
  'gi',
);

/**
 * `aws_access_key_id=`, `aws_secret_access_key=`, `api_key=`, `api-key=`.
 * The field name is kept so an operator can still see which credential it was.
 */
const ACCESS_KEY_ASSIGNMENT =
  /\b((?:aws_)?(?:secret_)?access_?key(?:_id)?|api[_-]?key)(\s*[=:]\s*["']?)[A-Za-z0-9/+=_-]{16,}/gi;

/** AWS (`AKIA`/`ASIA`), Aliyun (`LTAI`) and Tencent (`AKID`) key ids. */
const CLOUD_ACCESS_KEY =
  /\b(?:(?:AKIA|ASIA)[A-Z0-9]{16}|LTAI[A-Za-z0-9]{12,24}|AKID[A-Za-z0-9]{13,24})\b/g;

const EMAIL =
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * One dotted IPv4, public or private, each octet in 0..255.
 * A leading letter (`v1.30.4`) or a fifth numeric segment (`1.2.3.4.5`)
 * does not match. A trailing port (`10.0.0.1:8443`) is left in place.
 */
const IPV4 =
  /(?<![0-9.A-Za-z])(?:(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?![0-9.A-Za-z])/g;

interface MaskCounter {
  count: number;
}

function maskLiteral(
  input: string,
  pattern: RegExp,
  token: string,
  counter: MaskCounter,
): string {
  pattern.lastIndex = 0;
  return input.replace(pattern, () => {
    counter.count += 1;
    return token;
  });
}

/**
 * Replace IPv4 addresses, JWTs, access keys, inline passwords and mailboxes.
 *
 * @param raw - one container log line. Not mutated.
 * @returns the masked line and how many secrets were replaced.
 */
export function sanitizeRawLog(raw: string): SanitizedLog {
  const counter: MaskCounter = { count: 0 };
  let text = raw;

  text = maskLiteral(text, BEARER_JWT, REDACTION_MARKERS.token, counter);
  text = maskLiteral(text, BARE_JWT, REDACTION_MARKERS.token, counter);

  URL_USERINFO.lastIndex = 0;
  text = text.replace(URL_USERINFO, (_match: string, scheme: string, user: string) => {
    counter.count += 1;
    return `${scheme}${user}:${REDACTION_MARKERS.key}@`;
  });

  PASSWORD_ASSIGNMENT.lastIndex = 0;
  text = text.replace(
    PASSWORD_ASSIGNMENT,
    (_match: string, name: string, separator: string) => {
      counter.count += 1;
      return `${name}${separator}${REDACTION_MARKERS.key}`;
    },
  );

  ACCESS_KEY_ASSIGNMENT.lastIndex = 0;
  text = text.replace(
    ACCESS_KEY_ASSIGNMENT,
    (_match: string, name: string, separator: string) => {
      counter.count += 1;
      return `${name}${separator}${REDACTION_MARKERS.key}`;
    },
  );

  text = maskLiteral(text, CLOUD_ACCESS_KEY, REDACTION_MARKERS.key, counter);
  text = maskLiteral(text, EMAIL, REDACTION_MARKERS.email, counter);
  text = maskLiteral(text, IPV4, REDACTION_MARKERS.ip, counter);

  return { sanitized: text, maskedCount: counter.count };
}
