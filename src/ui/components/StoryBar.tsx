import { Button } from "@cloudflare/kumo";
import { ArrowCounterClockwise, ArrowLeft, ArrowRight, Pause, Play } from "@phosphor-icons/react";
import type { StoryStep } from "../lib/story";

interface StoryBarProps {
	steps: readonly StoryStep[];
	/** The step on screen, or -1 before the first has been reached. */
	index: number;
	/** The replay is running by itself, not being stepped through. */
	playing: boolean;
	/** The tape is on its way to the step that was asked for. */
	moving: boolean;
	onStep: (index: number) => void;
	onPlay: () => void;
	onPause: () => void;
	onRestart: () => void;
}

/**
 * The run as a story: one sentence about the moment on screen, a line or two under it, and Back
 * and Next. It is the biggest text on the page on purpose. Someone who has never seen Premise
 * should be able to follow the whole run by pressing Next.
 */
export function StoryBar({ steps, index, playing, moving, onStep, onPlay, onPause, onRestart }: StoryBarProps) {
	const shown = steps[Math.max(0, index)];
	if (shown === undefined) {
		return null;
	}
	const at = Math.max(0, index);
	const last = at >= steps.length - 1;
	return (
		<section className="story" aria-label="The run, step by step">
			<div className="story-text">
				<div className="story-progress">
					<span className="story-count">
						Step {String(at + 1).padStart(2, "0")} / {String(steps.length).padStart(2, "0")}
					</span>
					<span className="story-dots">
						{steps.map((step, position) => (
							<button key={step.id} type="button" className="story-dot" data-state={position < at ? "done" : position === at ? "now" : "ahead"} aria-label={`Step ${position + 1}: ${step.title}`} aria-current={position === at ? "step" : undefined} onClick={() => onStep(position)} />
						))}
					</span>
				</div>
				{/* The key makes the sentence fade in afresh at each step. */}
				<h1 key={shown.id} className="story-title" aria-live="polite">
					{shown.title}
				</h1>
				{shown.body ? (
					<p key={`${shown.id}-body`} className="story-body">
						{shown.body}
					</p>
				) : null}
			</div>
			<div className="story-controls">
				<Button variant="secondary" size="lg" disabled={at === 0 && index >= 0} onClick={() => onStep(at - 1)}>
					<ArrowLeft size={16} aria-hidden="true" />
					Back
				</Button>
				{last ? (
					<Button variant="primary" size="lg" onClick={onRestart}>
						<ArrowCounterClockwise size={16} aria-hidden="true" />
						Start again
					</Button>
				) : (
					<Button variant="primary" size="lg" loading={moving} onClick={() => onStep(at + 1)}>
						Next
						<ArrowRight size={16} aria-hidden="true" />
					</Button>
				)}
				<Button variant="ghost" size="lg" aria-label={playing ? "Pause" : "Play it through"} title={playing ? "Pause (Space)" : "Play it through at normal speed (Space)"} onClick={playing ? onPause : onPlay}>
					{playing ? <Pause size={16} weight="fill" aria-hidden="true" /> : <Play size={16} weight="fill" aria-hidden="true" />}
					<span className="story-play-word">{playing ? "Pause" : "Play"}</span>
				</Button>
			</div>
		</section>
	);
}
