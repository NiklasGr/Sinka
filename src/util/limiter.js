// Bounded concurrency for the provider tree walks.
//
// Both providers list a course by walking its folders, and both were latency-bound
// rather than CPU- or bandwidth-bound: one request at a time, each waiting for the
// previous. Sibling folders know nothing about each other, so the walk parallelises
// freely — but "freely" against a school's server means a wide course could open a
// hundred sockets at once, so the width needs a ceiling.
//
// Shared rather than copied into each provider: this is the one piece of the
// optimisation with non-obvious failure modes (a slot held across a recursive await
// deadlocks the walk against its own descendants), and a divergent second copy would
// hang one provider while the other stayed fine.

// Run at most `max` tasks at a time; queue the rest in submission order.
//
// Callers must gate only the leaf work (the HTTP calls), never a recursive step that
// waits on gated work itself — a parent holding a slot while its children queue for one
// is a deadlock.
function createLimiter(max) {
  let active = 0;
  const queue = [];

  const pump = () => {
    if (active >= max || queue.length === 0) return;
    active++;
    const { task, resolve, reject } = queue.shift();
    // Promise.resolve().then(task) so a task that throws *synchronously* still rejects
    // its own promise rather than propagating out of pump() and stalling the queue.
    Promise.resolve()
      .then(task)
      .then(resolve, reject)
      .finally(() => {
        active--;
        pump();
      });
  };

  return (task) =>
    new Promise((resolve, reject) => {
      queue.push({ task, resolve, reject });
      pump();
    });
}

module.exports = { createLimiter };
