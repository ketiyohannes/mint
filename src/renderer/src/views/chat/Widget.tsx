import { useState, type JSX } from 'react'
import type { ThreadMessage } from '@shared/types'
import { allTopics, findTopic } from '@shared/curriculum'
import { api, errorMessage } from '../../lib/api'
import { useApp } from '../../state/app'
import { Icon } from '../../components/Icon'
import { RichText } from '../../components/RichText'
import { Proposals } from '../../components/Proposals'
import { useStudy } from '../study/context'
import { useChat } from './chatContext'
import { QuestionsWidget } from './QuestionsWidget'
import { QuizWidget } from './QuizWidget'
import { CodeWidget } from './CodeWidget'
import { DiagramWidget } from './DiagramWidget'

/** Renders a message's interactive widget and sends the learner's answers. */
export function Widget({ message }: { message: ThreadMessage }): JSX.Element | null {
  const study = useStudy()
  const chat = useChat()
  const { toast } = useApp()
  const [sending, setSending] = useState(false)
  const w = message.widget
  if (!w) return null

  async function answer(a: Parameters<typeof api.chat.answer>[0]['answer']) {
    setSending(true)
    try {
      await api.chat.answer({ classId: study.classId, threadId: chat.threadId, messageId: message.id, answer: a })
    } catch (err) {
      toast(errorMessage(err), 'error')
    } finally {
      setSending(false)
    }
  }

  switch (w.kind) {
    case 'questions':
      return (
        <QuestionsWidget
          questions={w.questions}
          answers={w.answers}
          skipped={w.skipped}
          onSubmit={sending ? undefined : (answers) => void answer({ kind: 'questions', answers })}
          onSkip={() => void answer({ kind: 'questions', skip: true })}
        />
      )
    case 'quiz':
      return <QuizWidget title={w.title} questions={w.questions} choices={w.choices} onSubmit={sending ? undefined : (choices) => void answer({ kind: 'quiz', choices })} />
    case 'code':
      return <CodeWidget messageId={message.id} exercise={w.exercise} submission={w.submission} />
    case 'diagram':
      return <DiagramWidget explorable={study.bundle.explorables.find((e) => e.id === w.explorableId)} />
    case 'plan':
      return <PlanWidget />
    case 'lesson': {
      const session = study.bundle.sessions.find((s) => s.id === w.sessionId)
      if (!session) return <div className="widget muted small">This lesson is no longer available.</div>
      // The lesson itself lives in the Study tab; the chat keeps a pointer to it.
      const topic = findTopic(study.bundle.curriculum, session.topicId)
      const passed = new Set(session.attempts.filter((a) => a.verdict?.result === 'pass').map((a) => a.kind)).size
      return (
        <div className="widget lesson-card" data-testid="lesson-widget">
          <Icon name="study" size={18} />
          <div className="lesson-card-body">
            <RichText text={topic?.title ?? 'Lesson'} inline className="lesson-card-title" />
            <div className="small muted">
              {session.type === 'review' ? 'Review' : 'Lesson'} · {session.endedAt ? 'complete' : session.phase === 'wrap' ? 'wrapping up' : session.phase} · {passed}/3 checks passed
            </div>
          </div>
          <button className="btn sm" onClick={study.openStudy} data-testid="open-study">
            Open in Study <Icon name="arrow" size={12} />
          </button>
        </div>
      )
    }
    case 'sources':
      return (
        <div className="widget">
          <Proposals bundle={study.bundle} compact />
          {!study.bundle.sourceProposals.some((p) => p.status === 'proposed' || p.status === 'approved' || p.status === 'failed') && (
            <div className="small muted">
              {study.bundle.sources.length ? `${study.bundle.sources.length} source${study.bundle.sources.length > 1 ? 's' : ''} in this class.` : 'No sources imported.'}
            </div>
          )}
        </div>
      )
  }
}

function PlanWidget(): JSX.Element {
  const study = useStudy()
  const c = study.bundle.curriculum
  if (!c) return <div className="widget muted small">No plan yet.</div>
  const topics = allTopics(c)
  const mastered = topics.filter((t) => study.bundle.progress[t.id]?.status === 'mastered').length
  return (
    <div className="widget plan-widget" data-testid="plan-widget">
      <div className="widget-head">
        <Icon name="path" size={14} /> <b>Plan</b>
        <span className="muted small">
          {mastered}/{topics.length} done
        </span>
      </div>
      {c.milestones.map((m, i) => (
        <div key={m.id} className="pw-milestone">
          <div className="pw-title">
            <span className="muted">{String(i + 1).padStart(2, '0')}</span> <RichText text={m.title} inline />
          </div>
          {m.topics.map((t) => {
            const status = study.bundle.progress[t.id]?.status ?? 'locked'
            return (
              <div key={t.id} className={`pw-topic ${status}`}>
                <span className={`status-dot ${status}`}>{status === 'mastered' ? <Icon name="check" size={9} strokeWidth={3} /> : null}</span>
                <RichText text={t.title} inline />
              </div>
            )
          })}
        </div>
      ))}
      {study.bundle.nextTopicId && (
        <div className="widget-foot">
          <button className="btn sm primary" onClick={() => study.command('lesson')} data-testid="plan-start">
            <Icon name="play" size={11} /> Start the next lesson
          </button>
        </div>
      )}
    </div>
  )
}
