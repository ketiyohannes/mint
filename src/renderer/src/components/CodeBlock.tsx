import { Fragment, useMemo, type JSX } from 'react'
import { languageLabel, type LanguageId } from '@shared/languages'
import { highlightLines } from '../lib/codeLanguages'

/** Code as it was written, coloured like the editor colours it, with its language named. Not editable. */
export function CodeBlock({ code, language }: { code: string; language: LanguageId }): JSX.Element {
  const lines = useMemo(() => highlightLines(code, language), [code, language])
  return (
    <div className="code-shown" data-testid="code-shown" data-language={language}>
      <div className="code-shown-lang">{languageLabel(language)}</div>
      <pre>
        <code>
          {lines.map((line, i) => (
            <Fragment key={i}>
              {i > 0 && '\n'}
              {line.map((t, j) =>
                t.classes ? (
                  <span key={j} className={t.classes}>
                    {t.text}
                  </span>
                ) : (
                  t.text
                )
              )}
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  )
}
