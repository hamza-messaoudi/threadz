/** Directory input. A plain validated text field (the server checks the path). */
export function DirField({ value, onChange }: { value: string | null; onChange: (v: string | null) => void }) {
  return (
    <input
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value || null)}
      placeholder="~/code/my-repo"
      spellCheck={false}
    />
  );
}
