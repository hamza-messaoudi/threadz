# Heading one: release notes

A paragraph with **strong text**, *emphasis*, ***both***, ~~strikethrough~~, `inline code`, a [dotted link](https://example.com/docs) and an autolinked URL: https://example.com/a/very/long/path/that/should/wrap/instead/of/widening/the/message/column/at/all?with=query&and=more.

## Heading two

Second paragraph with a hard  
line break, a footnote-like marker[^1] kept as text, and an HTML tag <b>shown as text</b>.

### Heading three

#### Heading four

##### Heading five

###### Heading six

- Unordered item one
- Unordered item two with a longer sentence that wraps onto a second line when the column is narrow enough to force it
  - Nested item
  - Another nested item
- Item three

1. Ordered item one
2. Ordered item two
   1. Nested ordered
3. Ordered item three

- [x] Task done
- [ ] Task still open
- [ ] Task with `code`

> A blockquote with a [link](https://example.com) and **bold** text.
>
> A second paragraph in the same quote.

---

| Left | Center | Right |
| :--- | :----: | ----: |
| `cell` | mid | 1,204 |
| [link](https://example.com) | **bold** | 98.5 % |
| a much longer cell that makes the table wider than a narrow column | x | 3 |

```
A fenced block with no language.
  Indented line.
```

```ts
export function sum(values: number[]): number {
  return values.reduce((a, b) => a + b, 0);
}
```

    indented code block

![A diagram of the request path](/dev/sample.svg)

Final paragraph with an inline image ![dot](/dev/sample.svg) and trailing text.
