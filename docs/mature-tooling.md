# Mature tooling

NEXUS should borrow mature components when they already own the hard platform-specific problem.

| Need | Component | NEXUS owns |
| --- | --- | --- |
| Frame telemetry | PresentMon | Validation, statistics, decisions |
| Stability evidence | Windows Event Log | Interpretation and rollback policy |
| CPU placement | Windows CPU Sets | Workload policy and safety |
| Sensors | LibreHardwareMonitor / HWiNFO | Fidelity and normalization |
| Tool protocol | MCP | Authorization and machine authority |
| Local models | llama.cpp / Ollama | Model policy and memory |

Rule: borrow the component, not its authority. External components are evidence providers or execution primitives. They never widen NEXUS safety policy.

For source reuse, only compatible-licensed code is directly incorporated. Otherwise NEXUS uses the mature project as an executable dependency, API reference, or behavioral specification.
