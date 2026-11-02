import { useState, type JSX } from 'react'
import type { Intake, MaterialsMode, Mission } from '@shared/types'
import { useApp } from '../state/app'
import { api } from '../lib/api'
import { Icon } from '../components/Icon'

const lines = (s: string) =>
  s
    .split('\n')
    .map((l) => l.replace(/^[-*•]\s*/, '').trim())
    .filter(Boolean)

/** Intake, step 1: mission and context (the /teach intake). Materials come next, inside the class. */
export function NewClassView(): JSX.Element {
  const { go, run, refreshClasses } = useApp()
  const [step, setStep] = useState(0)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState({
    title: '',
    topic: '',
    why: '',
    success: '',
    constraints: '',
    outOfScope: '',
    timeline: '',
    timePerWeek: '',
    sessionLength: '30 minutes',
    priorExperience: '',
    preferences: '',
    materialsMode: 'own' as MaterialsMode
  })
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }))

  const canNext = step === 0 ? f.topic.trim().length > 1 && f.why.trim().length > 3 : true

  async function create() {
    setBusy(true)
    const mission: Mission = {
      topic: f.topic.trim(),
      why: f.why.trim(),
      successLooksLike: lines(f.success),
      constraints: lines(f.constraints),
      outOfScope: lines(f.outOfScope)
    }
    const intake: Intake = {
      timeline: f.timeline,
      timePerWeek: f.timePerWeek,
      sessionLength: f.sessionLength,
      priorExperience: f.priorExperience,
      preferences: f.preferences,
      materialsMode: f.materialsMode
    }
    const meta = await run(() => api.classes.create({ title: f.title.trim() || f.topic.trim(), mission, intake }))
    setBusy(false)
    if (meta) {
      await refreshClasses()
      go({ name: 'class', classId: meta.id, tab: 'path' })
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="crumbs">
          <span>Classes</span>/<b>New class</b>
        </div>
      </div>
      <div className="page">
        <div className="page-inner page-narrow">
          <h1 className="page-title">New class</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            A few questions first. Your answers ground every lesson, so be concrete.
          </p>
          <div className="steps" style={{ marginTop: 20 }}>
            {[0, 1, 2].map((i) => (
              <div key={i} className={`step ${i <= step ? 'on' : ''}`} />
            ))}
          </div>

          {step === 0 && (
            <div className="fade-in">
              <div className="field">
                <label htmlFor="topic">What do you want to learn?</label>
                <input id="topic" className="input" placeholder="e.g. Linear algebra for machine learning" value={f.topic} onChange={set('topic')} autoFocus />
              </div>
              <div className="field">
                <label htmlFor="why">Why? What changes for you when you have this skill?</label>
                <textarea id="why" className="textarea" placeholder="e.g. I want to read ML papers and actually follow the math, so I can build a small recommender at work." value={f.why} onChange={set('why')} />
                <span className="hint">Concrete beats abstract: "ship a Rust CLI to my team" beats "learn Rust".</span>
              </div>
              <div className="field">
                <label htmlFor="success">Success looks like (one per line)</label>
                <textarea id="success" className="textarea" placeholder={'Explain eigenvectors to a colleague\nImplement PCA from scratch'} value={f.success} onChange={set('success')} />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="constraints">Constraints (optional)</label>
                  <textarea id="constraints" className="textarea" placeholder="Budget, tools, anything that bounds the approach" value={f.constraints} onChange={set('constraints')} />
                </div>
                <div className="field">
                  <label htmlFor="oos">Out of scope (optional)</label>
                  <textarea id="oos" className="textarea" placeholder="Things to deliberately skip for now" value={f.outOfScope} onChange={set('outOfScope')} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="title">Class name (optional)</label>
                <input id="title" className="input" placeholder={f.topic || 'Defaults to the topic'} value={f.title} onChange={set('title')} />
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="fade-in">
              <div className="grid-2">
                <div className="field">
                  <label htmlFor="timeline">Timeline or deadline</label>
                  <input id="timeline" className="input" placeholder="e.g. 6 weeks, exam on March 3" value={f.timeline} onChange={set('timeline')} />
                </div>
                <div className="field">
                  <label htmlFor="tpw">Time you can reliably give</label>
                  <input id="tpw" className="input" placeholder="e.g. 3 hours a week" value={f.timePerWeek} onChange={set('timePerWeek')} />
                </div>
              </div>
              <div className="field">
                <label htmlFor="len">Typical session length</label>
                <select id="len" className="select" value={f.sessionLength} onChange={set('sessionLength')}>
                  {['15 minutes', '30 minutes', '45 minutes', '1 hour', '90 minutes'].map((o) => (
                    <option key={o}>{o}</option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="prior">Prior experience</label>
                <textarea id="prior" className="textarea" placeholder="What have you already studied or built that is related? How deep?" value={f.priorExperience} onChange={set('priorExperience')} />
              </div>
              <div className="field">
                <label htmlFor="prefs">How do you like to learn? (optional)</label>
                <textarea id="prefs" className="textarea" placeholder="e.g. Visual intuition first, then formulas. I like worked examples." value={f.preferences} onChange={set('preferences')} />
              </div>
            </div>
          )}

          {step === 2 && (
            <div className="fade-in">
              <div className="label" style={{ marginBottom: 10 }}>
                Where will you learn from?
              </div>
              <div className="radio-cards">
                {(
                  [
                    ['own', 'My own materials', 'Books, papers, notes, docs or videos you bring. mint never strays from them.'],
                    ['trusted', 'Build it from trusted sources', 'mint proposes a reading list from trusted public sites and YouTube. You approve each one.'],
                    ['mixed', 'Both', 'Your materials, plus trusted sources to fill the gaps.']
                  ] as const
                ).map(([value, title, desc]) => (
                  <button key={value} type="button" className={`radio-card ${f.materialsMode === value ? 'on' : ''}`} onClick={() => setF((s) => ({ ...s, materialsMode: value }))}>
                    <b>{title}</b>
                    <span className="small muted">{desc}</span>
                  </button>
                ))}
              </div>
              <p className="hint" style={{ marginTop: 14 }}>
                Next you will add materials, take a short diagnostic, and approve your curriculum.
              </p>
            </div>
          )}

          <div className="row" style={{ marginTop: 24 }}>
            {step > 0 ? (
              <button className="btn" onClick={() => setStep(step - 1)}>
                <Icon name="back" /> Back
              </button>
            ) : (
              <button className="btn ghost" onClick={() => go({ name: 'home' })}>
                Cancel
              </button>
            )}
            <span className="spacer" />
            {step < 2 ? (
              <button className="btn primary" disabled={!canNext} onClick={() => setStep(step + 1)} data-testid="intake-next">
                Continue <Icon name="arrow" />
              </button>
            ) : (
              <button className="btn primary" disabled={busy} onClick={create} data-testid="intake-create">
                {busy ? <span className="spinner" /> : <Icon name="check" />} Create class
              </button>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
