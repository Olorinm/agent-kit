import { useRef, useState } from "react";
import clsx from "clsx";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { ChatButton as Button, useChatLabels } from "./provider.js";
export type PendingActionResult = void | Promise<unknown>;
export type QuestionAnswers = Record<string, string | string[]>;
export interface QuestionPage {
  id: string;
  title: string;
  description?: string;
  multiSelect?: boolean;
  secret?: boolean;
  allowCustom?: boolean;
  options: Array<{ value: string; label: string; description?: string }>;
}
function answerPresent(value: string | string[] | undefined): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim());
}
export function QuestionForm(props: {
  questions: QuestionPage[];
  title?: string;
  disabledReason?: string;
  allowSkip?: boolean;
  onAnswer(answer: QuestionAnswers): PendingActionResult;
  onDecline(): PendingActionResult;
  onCancel(): PendingActionResult;
}) {
  const { t } = useChatLabels();
  const questions = props.questions;
  const [pageIndex, setPageIndex] = useState(0);
  const [answers, setAnswers] = useState<QuestionAnswers>({});
  const [skippedQuestions, setSkippedQuestions] = useState<
    Record<string, boolean>
  >({});
  const [customAnswers, setCustomAnswers] = useState<Record<string, string>>(
    {},
  );
  const [customAnswerOpen, setCustomAnswerOpen] = useState<
    Record<string, boolean>
  >({});
  const [resolutionPending, setResolutionPending] = useState(false);
  const page =
    questions[Math.min(pageIndex, Math.max(questions.length - 1, 0))];
  const options = page?.options ?? [];
  const currentValue = page ? (answers[page.id] ?? "") : "";
  const currentAnswer = Array.isArray(currentValue)
    ? currentValue.join(", ")
    : currentValue;
  const optionValues = options.map((option) => option.value || option.label);
  const currentAnswerIsCustom = Boolean(
    page &&
      currentAnswer &&
      !page.multiSelect &&
      !optionValues.includes(currentAnswer),
  );
  const currentCustomAnswer = page
    ? (customAnswers[page.id] ?? (currentAnswerIsCustom ? currentAnswer : ""))
    : "";
  const currentSelections = Array.isArray(currentValue) ? currentValue : [];
  const isCustomAnswerOpen = Boolean(page && customAnswerOpen[page.id]);
  const currentAnswered = currentAnswer.trim().length > 0;
  const hasMultipleQuestions = questions.length > 1;
  const canGoBack = pageIndex > 0;
  const canGoForward = pageIndex < questions.length - 1;
  const questionIsDone = (
    question: { id: string },
    nextAnswers = answers,
    nextSkipped = skippedQuestions,
  ) =>
    answerPresent(nextAnswers[question.id]) ||
    Boolean(nextSkipped[question.id]);
  const allQuestionsDone = questions.every((question) =>
    questionIsDone(question),
  );
  const firstIncompleteQuestionIndex = (
    nextAnswers = answers,
    nextSkipped = skippedQuestions,
  ) =>
    questions.findIndex(
      (question) => !questionIsDone(question, nextAnswers, nextSkipped),
    );
  const disabled = Boolean(props.disabledReason) || resolutionPending;
  const resolutionLock = useRef(false);
  const [resolutionError, setResolutionError] = useState("");
  const runResolution = (resolve: () => PendingActionResult) => {
    if (disabled || resolutionLock.current) return;
    resolutionLock.current = true;
    setResolutionPending(true);
    setResolutionError("");
    Promise.resolve()
      .then(resolve)
      .catch((error: unknown) => {
        resolutionLock.current = false;
        setResolutionPending(false);
        setResolutionError(
          error instanceof Error ? error.message : String(error),
        );
      });
  };
  const answerCurrentQuestion = (value: string) => {
    if (disabled) return;
    if (!page) return;
    setAnswers((current) => ({ ...current, [page.id]: value }));
    setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
  };
  const advanceOrSubmit = (nextAnswers: QuestionAnswers) => {
    if (hasMultipleQuestions && canGoForward) {
      setPageIndex((current) => Math.min(questions.length - 1, current + 1));
      return;
    }
    const incompleteIndex = firstIncompleteQuestionIndex(nextAnswers);
    if (hasMultipleQuestions && incompleteIndex >= 0) {
      setPageIndex(incompleteIndex);
      return;
    }
    runResolution(() => props.onAnswer(nextAnswers));
  };
  const submitAnswers = (nextAnswers = answers) => {
    if (disabled) return;
    if (!questions.length) {
      runResolution(() => props.onAnswer({}));
      return;
    }
    const complete = questions.every((question) =>
      questionIsDone(question, nextAnswers),
    );
    if (!complete) return;
    const output = { ...nextAnswers };
    if (page && !options.length) {
      output[page.id] = currentAnswer;
    }
    runResolution(() => props.onAnswer(output));
  };
  const chooseOption = (option: { value: string; label: string }) => {
    if (disabled) return;
    if (!page) return;
    const value = option.value || option.label;
    setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
    if (page.multiSelect) {
      const selected = currentSelections.includes(value);
      const nextSelections = selected
        ? currentSelections.filter((item) => item !== value)
        : [...currentSelections, value];
      setAnswers({ ...answers, [page.id]: nextSelections });
      setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
      return;
    }
    const nextAnswers = { ...answers, [page.id]: value };
    setAnswers(nextAnswers);
    setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
    advanceOrSubmit(nextAnswers);
  };
  const submitCustomAnswer = () => {
    if (disabled) return;
    if (!page) return;
    const value = currentCustomAnswer.trim();
    if (!value) return;
    if (page.multiSelect) {
      const nextSelections = currentSelections.includes(value)
        ? currentSelections
        : [...currentSelections, value];
      const nextAnswers = { ...answers, [page.id]: nextSelections };
      setAnswers(nextAnswers);
      setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
      setCustomAnswers((current) => ({ ...current, [page.id]: "" }));
      setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
      return;
    }
    const nextAnswers = { ...answers, [page.id]: value };
    setAnswers(nextAnswers);
    setSkippedQuestions((current) => ({ ...current, [page.id]: false }));
    setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
    advanceOrSubmit(nextAnswers);
  };
  const skipCurrentQuestion = () => {
    if (disabled) return;
    if (!page) return;
    const nextAnswers = { ...answers };
    delete nextAnswers[page.id];
    const nextSkipped = { ...skippedQuestions, [page.id]: true };
    setAnswers(nextAnswers);
    setSkippedQuestions(nextSkipped);
    setCustomAnswers((current) => ({ ...current, [page.id]: "" }));
    setCustomAnswerOpen((current) => ({ ...current, [page.id]: false }));
    if (hasMultipleQuestions && canGoForward) {
      setPageIndex((current) => Math.min(questions.length - 1, current + 1));
      return;
    }
    const incompleteIndex = firstIncompleteQuestionIndex(
      nextAnswers,
      nextSkipped,
    );
    if (incompleteIndex >= 0) {
      setPageIndex(incompleteIndex);
      return;
    }
    runResolution(() => props.onAnswer(nextAnswers));
  };
  return (
    <section
      className={clsx(
        "thread-question-card",
        resolutionPending ? "is-resolving" : null,
      )}
      aria-busy={resolutionPending || undefined}
    >
      <div className="thread-question-card-header">
        <div>
          <div className="thread-question-card-title">
            {page?.title || props.title}
          </div>
          {page?.description ? (
            <div className="thread-question-card-description">
              {page.description}
            </div>
          ) : null}
        </div>
        {hasMultipleQuestions ? (
          <div
            className="thread-question-card-nav"
            aria-label={t("activity.questionPaginationAria")}
          >
            <button
              type="button"
              disabled={!canGoBack || disabled}
              onClick={() =>
                setPageIndex((current) => Math.max(0, current - 1))
              }
              aria-label={t("activity.prevQuestion")}
            >
              <ChevronLeft size={16} strokeWidth={2.1} />
            </button>
            <span>
              {pageIndex + 1} / {questions.length}
            </span>
            <button
              type="button"
              disabled={!canGoForward || disabled}
              onClick={() =>
                setPageIndex((current) =>
                  Math.min(questions.length - 1, current + 1),
                )
              }
              aria-label={t("activity.nextQuestion")}
            >
              <ChevronRight size={16} strokeWidth={2.1} />
            </button>
          </div>
        ) : null}
      </div>
      {options.length ? (
        <div className="thread-question-options">
          {options.map((option, index) => (
            <button
              className={clsx(
                "thread-question-option",
                page?.multiSelect
                  ? currentSelections.includes(option.value || option.label)
                    ? "selected"
                    : null
                  : currentAnswer === option.value ||
                      currentAnswer === option.label
                    ? "selected"
                    : null,
              )}
              key={`${option.value}-${index}`}
              type="button"
              aria-pressed={
                page?.multiSelect
                  ? currentSelections.includes(option.value || option.label)
                  : undefined
              }
              disabled={disabled}
              onClick={() => chooseOption(option)}
            >
              <span className="thread-question-option-index">{index + 1}.</span>
              <span className="thread-question-option-label">
                {option.label}
              </span>
              {option.description ? (
                <span className="thread-question-option-description">
                  {option.description}
                </span>
              ) : null}
            </button>
          ))}
          {page?.allowCustom === false ? null : isCustomAnswerOpen ? (
            <div className="thread-question-custom-answer">
              <input
                type={page?.secret ? "password" : "text"}
                autoComplete={page?.secret ? "new-password" : "off"}
                autoFocus
                value={currentCustomAnswer}
                disabled={disabled}
                onChange={(event) => {
                  if (!page) return;
                  setCustomAnswers((current) => ({
                    ...current,
                    [page.id]: event.target.value,
                  }));
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    submitCustomAnswer();
                  }
                }}
                placeholder={t("activity.customAnswerPlaceholder")}
              />
              <Button
                disabled={!currentCustomAnswer.trim() || disabled}
                onClick={submitCustomAnswer}
              >
                {resolutionPending
                  ? t("activity.submitting")
                  : page?.multiSelect
                    ? t("activity.add")
                    : canGoForward
                      ? t("activity.continue")
                      : t("activity.submit")}
              </Button>
              <Button
                disabled={disabled}
                onClick={() => {
                  if (!page) return;
                  setCustomAnswers((current) => ({
                    ...current,
                    [page.id]: "",
                  }));
                  setCustomAnswerOpen((current) => ({
                    ...current,
                    [page.id]: false,
                  }));
                }}
              >
                {t("common.cancel")}
              </Button>
            </div>
          ) : (
            <button
              className={clsx(
                "thread-question-option",
                currentAnswerIsCustom ? "selected" : null,
              )}
              type="button"
              disabled={disabled}
              onClick={() => {
                if (!page) return;
                setCustomAnswerOpen((current) => ({
                  ...current,
                  [page.id]: true,
                }));
              }}
            >
              <span className="thread-question-option-index">
                {options.length + 1}.
              </span>
              <span className="thread-question-option-label">
                {t("activity.otherOption")}
              </span>
              <span className="thread-question-option-description">
                {currentAnswerIsCustom
                  ? page?.secret
                    ? "••••••"
                    : currentAnswer
                  : t("activity.ownAnswerHint")}
              </span>
            </button>
          )}
        </div>
      ) : page?.secret ? (
        <input
          type="password"
          autoComplete="new-password"
          className="thread-approval-input"
          value={currentAnswer}
          disabled={disabled}
          onChange={(event) => answerCurrentQuestion(event.target.value)}
          aria-label={page.title}
          placeholder={t("activity.answerPlaceholder")}
        />
      ) : (
        <textarea
          className="thread-approval-input"
          value={currentAnswer}
          disabled={disabled}
          onChange={(event) => answerCurrentQuestion(event.target.value)}
          placeholder={t("activity.answerPlaceholder")}
          aria-label={page?.title || props.title}
          rows={3}
        />
      )}
      {resolutionError ? (
        <div className="thread-approval-error" role="alert">
          {resolutionError}
        </div>
      ) : null}
      {props.disabledReason ? (
        <div className="thread-question-card-expired">
          {props.disabledReason}
        </div>
      ) : (
        <div className="thread-approval-actions compact">
          {hasMultipleQuestions && canGoBack ? (
            <Button
              disabled={disabled}
              onClick={() =>
                setPageIndex((current) => Math.max(0, current - 1))
              }
            >
              {t("activity.prevQuestion")}
            </Button>
          ) : null}
          {hasMultipleQuestions &&
          canGoForward &&
          (!options.length || page?.multiSelect) ? (
            <Button
              variant="primary"
              disabled={!currentAnswered || disabled}
              onClick={() =>
                setPageIndex((current) =>
                  Math.min(questions.length - 1, current + 1),
                )
              }
            >
              {t("activity.continue")}
            </Button>
          ) : null}
          {options.length &&
          page?.multiSelect &&
          hasMultipleQuestions &&
          !canGoForward ? (
            <Button
              variant="primary"
              disabled={!allQuestionsDone || disabled}
              onClick={() => submitAnswers()}
            >
              {resolutionPending
                ? t("activity.submitting")
                : allQuestionsDone
                  ? t("activity.submit")
                  : t("activity.submitAfterAll")}
            </Button>
          ) : null}
          {options.length && page?.multiSelect && !hasMultipleQuestions ? (
            <Button
              variant="primary"
              disabled={!allQuestionsDone || disabled}
              onClick={() => submitAnswers()}
            >
              {resolutionPending
                ? t("activity.submitting")
                : t("activity.submit")}
            </Button>
          ) : null}
          {!options.length && !canGoForward ? (
            <Button
              variant="primary"
              disabled={!allQuestionsDone || disabled}
              onClick={() => submitAnswers()}
            >
              {resolutionPending
                ? t("activity.submitting")
                : t("activity.answer")}
            </Button>
          ) : null}
          {hasMultipleQuestions && props.allowSkip !== false ? (
            <Button disabled={disabled} onClick={skipCurrentQuestion}>
              {resolutionPending
                ? t("activity.submitting")
                : t("activity.skip")}
            </Button>
          ) : null}
          <Button
            disabled={disabled}
            onClick={() => runResolution(props.onDecline)}
            title={
              hasMultipleQuestions ? t("activity.declineAllTooltip") : undefined
            }
          >
            {resolutionPending
              ? hasMultipleQuestions
                ? t("activity.cancelling")
                : t("activity.skipping")
              : hasMultipleQuestions
                ? t("activity.cancelAll")
                : t("activity.skip")}
          </Button>
          <Button
            disabled={disabled}
            onClick={() => runResolution(props.onCancel)}
          >
            {resolutionPending
              ? t("activity.cancelling")
              : t("activity.cancelRun")}
          </Button>
        </div>
      )}
    </section>
  );
}
