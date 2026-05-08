# Contributing to EagleEye

Thank you for your interest in contributing! 🦅

## How to Contribute

1. **Fork** the repository on GitHub
2. **Clone** your fork: `git clone https://github.com/krishnabagal/eagleeye.git`
3. **Install** dependencies: `cd eagleeye && npm install`
4. **Create a branch**: `git checkout -b feature/your-feature-name`
5. **Make your changes** and test locally with `node server.js`
6. **Commit**: `git commit -m "feat: describe your change"`
7. **Push**: `git push origin feature/your-feature-name`
8. **Open a Pull Request** on GitHub

## Commit Message Format

Use [Conventional Commits](https://www.conventionalcommits.org/):

| Prefix | Use for |
|--------|---------|
| `feat:` | New feature |
| `fix:` | Bug fix |
| `docs:` | Documentation changes only |
| `style:` | Formatting, no logic changes |
| `refactor:` | Code restructure without feature change |
| `perf:` | Performance improvement |

**Examples:**
```
feat: add ElastiCache inventory card
fix: correct date range for previous month CE query
docs: add example API response to README
```

## Code Style

- 2-space indentation throughout
- Keep functions small and single-purpose
- Add comments for non-obvious AWS API interactions
- Test with a real EC2 IAM role before submitting
- Keep all AWS calls read-only — no `Create`, `Delete`, or `Modify` actions

## Testing Locally Without an EC2 IAM Role

You can test the UI with mock data by temporarily modifying `/api/billing` in `server.js`
to return a hardcoded JSON response. The frontend will render normally from any JSON
matching the documented response shape.

## Reporting Bugs

Open a GitHub issue and include:
- Node.js version (`node --version`)
- AWS region you were using
- Full error message and stack trace from the terminal
- Steps to reproduce

## Feature Requests

Open a GitHub issue with the label `enhancement`. Please describe:
- What problem it solves
- How you'd expect it to work
- Any AWS APIs it would require

## Adding a New Recommendation

1. Open `server.js` and find `buildRecommendations()`
2. Add your check following the existing pattern:
   ```js
   if (infraStats.something > 0) {
     recs.push({
       category: 'Category Name',
       priority: 'HIGH' | 'MEDIUM' | 'LOW',
       icon: '🔧',
       title: 'Short actionable title',
       description: 'Explain why this saves money with specific numbers.',
       monthlySaving: estimatedDollars,
       action: 'Exact console steps to implement this',
     });
   }
   ```
3. The engine automatically sorts by priority then saving amount

## Adding a New Infrastructure Card

1. Add the AWS API call in `server.js` following existing `fetch*()` patterns
2. Add the result to the `infra` object in `fetchAllData()`
3. Add a card entry to the `cards` array in `renderInfra()` in `index.html`
4. Add the required IAM action to `eagleeye-iam-policy.json`
5. Update the IAM permissions table in `README.md`

## License

By contributing, you agree your code will be released under the [MIT License](LICENSE).
