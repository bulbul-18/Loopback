const fetch = require('node-fetch');

const LEETCODE_GRAPHQL = 'https://leetcode.com/graphql';

/**
 * Fetches the user's most recent ACCEPTED submissions.
 * LeetCode's recentAcSubmissionList already filters to accepted-only,
 * which is exactly the "new solve" event LoopBack cares about.
 */
async function fetchRecentAccepted(username, limit = 20) {
  const query = `
    query recentAcSubmissions($username: String!, $limit: Int!) {
      recentAcSubmissionList(username: $username, limit: $limit) {
        title
        titleSlug
        timestamp
      }
    }
  `;

  const res = await fetch(LEETCODE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { username, limit } }),
  });

  if (!res.ok) {
    throw new Error(`LeetCode API responded with ${res.status}`);
  }

  const json = await res.json();
  if (json.errors) {
    throw new Error(`LeetCode API error: ${JSON.stringify(json.errors)}`);
  }

  return (json.data?.recentAcSubmissionList || []).map((s) => ({
    title: s.title,
    titleSlug: s.titleSlug,
    // LeetCode returns a unix seconds string
    acceptedAt: new Date(Number(s.timestamp) * 1000),
  }));
}

/**
 * Fetches difficulty + numeric id for a single problem by its slug.
 * Called once per NEW problem only (not on every sync) to keep this cheap.
 */
async function fetchProblemDetails(titleSlug) {
  const query = `
    query questionDetails($titleSlug: String!) {
      question(titleSlug: $titleSlug) {
        questionFrontendId
        title
        difficulty
      }
    }
  `;

  const res = await fetch(LEETCODE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables: { titleSlug } }),
  });

  if (!res.ok) {
    throw new Error(`LeetCode API responded with ${res.status}`);
  }

  const json = await res.json();
  const q = json.data?.question;
  if (!q) return { leetcodeId: null, difficulty: null };

  return {
    leetcodeId: q.questionFrontendId ? Number(q.questionFrontendId) : null,
    difficulty: q.difficulty || null,
  };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Same as fetchProblemDetails, but retries on failure (including 429 rate
 * limits) with a short exponential backoff instead of taking down the whole
 * sync over one flaky request.
 */
async function fetchProblemDetailsWithRetry(titleSlug, maxAttempts = 3) {
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fetchProblemDetails(titleSlug);
    } catch (err) {
      lastErr = err;
      if (attempt < maxAttempts) await sleep(400 * attempt);
    }
  }
  throw lastErr;
}

module.exports = { fetchRecentAccepted, fetchProblemDetails, fetchProblemDetailsWithRetry, sleep };
