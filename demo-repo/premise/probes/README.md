# probes

End-to-end checks of what the running system does, written with the tasks. Nothing runs them
before a change lands: not the agents, which cannot see this directory, and not the gate. They
are run after each landing, only to measure. A probe that goes red is a behavioural regression
that reached trunk.

They are separate from `premise/hidden-tests/`, which are each task's reference checks and which
the gate does run. Where a task's checks exercise the real code end to end, the two say the same
thing and the task has no probe. A task has a probe when its checks use a stand-in for something
(as unit tests often do), because then the checks can pass while the real path is broken.
