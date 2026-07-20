Architect a solution before writing any code. Usage: /plan [what to build]

$ARGUMENTS is the feature or task description.

Think through this completely BEFORE touching any file:

1. UNDERSTAND
   - What exactly does this need to do? (inputs → outputs)
   - What already exists that this connects to or modifies?
   - Read every relevant file mentioned in the task — front to back

2. DESIGN
   Use sequential thinking to answer:
   - What is the simplest architecture that solves this completely?
   - What data flows through the system? Where does it come from, where does it go?
   - What are the failure modes? What happens when X is null, empty, or offline?
   - What existing code can be reused vs what needs to be written fresh?
   - What is the exact order of implementation?

3. PLAN OUTPUT
   Deliver this before writing a single line:

   ---
   PLAN: [feature name]
   ---
   WHAT IT DOES: [2 sentences max]

   FILES TO CHANGE:
   • [file] — [exactly what changes and why]

   FILES TO CREATE:
   • [file] — [what it contains]

   IMPLEMENTATION ORDER:
   1. [first thing — why first]
   2. [second thing]
   3. [etc.]

   RISKS:
   • [what could go wrong and how it's handled]

   ESTIMATED COMPLEXITY: [Simple / Medium / Complex]
   ---

4. Wait for approval before writing any code.
   If approved, implement step by step, verifying each step works before the next.
