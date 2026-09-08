/**
 * The one rule about what a completed request may put on the page.
 *
 * A controller starts a request for the session that is on screen, the session
 * ends underneath it -- a sign-out, or a second identity signing in in the same
 * document -- and the handler paints the answer anyway. The next, possibly
 * lower-privileged, user then reads the previous one's data or the previous
 * one's error. #372 fixed three handlers that way, #381 fixed three more, and
 * two files still had it: each fix was correct and each left the next one,
 * because "did you check currency?" was a question the reviewer had to
 * remember to ask.
 *
 * The reason it stayed invisible is worth stating. The check was a boolean --
 * handleFailure(error) -- and it meant opposite things in different files: the
 * shell returns true for a session that has moved on, so its callers stop,
 * while team, projects, clients and tasks returned false, so theirs carried
 * straight on into the paint they were supposed to skip. Two conventions, one
 * name.
 *
 * So there is no boolean to read backwards here. A session hands its write to
 * present(), and the failed half of the same handler hands its error and its
 * write to presentFailure(); nothing else reaches onSessionFailure, which the
 * session handles no longer carry. A handler cannot report a failure without
 * naming the session the report is for. Success, failure and finally alike go
 * through here, because one guard per handler is how the fourth handler misses
 * it.
 */
export interface SessionPresenter {
  /**
   * Paint for this session, or do nothing. Returns whether the write ran, so a
   * caller that has to report "the page now shows the new record" reads it off
   * this call instead of asking after currency a second time.
   */
  readonly present: (paint: () => void) => boolean
  /**
   * The failed half. The error reaches the shell only while this session is
   * still the one on screen -- a stale 401 arriving after someone else has
   * signed in must not sign *them* out -- and nothing is painted once the shell
   * has taken the failure over, because by then the page the write was
   * addressed to is the sign-in screen.
   */
  readonly presentFailure: (error: unknown, paint: () => void) => boolean
}

/**
 * isCurrent is the controller's own answer to "is this still the session on
 * screen?". There are two independent ways to lose that -- another activate()
 * took the document, or the shell aborted this one on its way out -- and
 * neither implies the other, so the controller keeps owning the answer rather
 * than having one guessed for it here.
 */
export const sessionPresenter = (
  isCurrent: () => boolean,
  onSessionFailure: (error: unknown) => boolean,
): SessionPresenter => {
  const present = (paint: () => void): boolean => {
    if (!isCurrent()) return false
    paint()
    return true
  }
  return {
    present,
    presentFailure: (error: unknown, paint: () => void): boolean => {
      if (!isCurrent()) return false
      if (onSessionFailure(error)) return false
      return present(paint)
    },
  }
}
