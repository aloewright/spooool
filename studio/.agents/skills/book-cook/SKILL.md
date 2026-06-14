```markdown
# book-cook Development Patterns

> Auto-generated skill from repository analysis

## Overview
This skill teaches the core development patterns used in the `book-cook` TypeScript repository. It covers file naming conventions, import/export styles, commit message patterns, and testing approaches. By following these guidelines, contributors can maintain consistency and quality across the codebase.

## Coding Conventions

### File Naming
- **Style:** PascalCase
- **Example:**  
  ```
  BookList.ts
  RecipeManager.ts
  ```

### Import Style
- **Relative imports are preferred.**
- **Example:**
  ```typescript
  import { Book } from './Book';
  import { getRecipe } from '../utils/RecipeUtils';
  ```

### Export Style
- **Mixed usage of default and named exports.**
- **Examples:**
  ```typescript
  // Named export
  export function getBookList() { ... }

  // Default export
  export default class RecipeManager { ... }
  ```

### Commit Message Pattern
- **Conventional commits with prefixes.**
- **Common Prefix:** `refactor`
- **Example:**
  ```
  refactor: update RecipeManager to use new API
  ```

## Workflows

### Refactoring Code
**Trigger:** When improving code structure or readability without changing functionality  
**Command:** `/refactor`

1. Identify code that can be improved (e.g., simplify logic, rename variables).
2. Make changes while ensuring no functional changes are introduced.
3. Use a conventional commit message with the `refactor` prefix:
   ```
   refactor: improve readability of BookList
   ```
4. Run tests to confirm no regressions.
5. Submit a pull request for review.

## Testing Patterns

- **Test files use the pattern:** `*.test.*`
- **Testing framework:** Unknown (check project for details)
- **Example:**
  ```
  BookList.test.ts
  ```
- **Typical test structure:**
  ```typescript
  describe('BookList', () => {
    it('should return all books', () => {
      // test implementation
    });
  });
  ```

## Commands
| Command     | Purpose                                  |
|-------------|------------------------------------------|
| /refactor   | Start a code refactoring workflow        |
```
