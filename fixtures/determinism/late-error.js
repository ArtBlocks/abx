abx.traits({phase: "initial"}); abx.done(); setTimeout(() => { throw new Error("late render error"); }, 300);
