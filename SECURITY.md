# Security policy

This document records the project's security posture and any known limitations
that operators should be aware of when deploying universal-memory.

For the broader threat model and design rationale, see
`docs/design/` (gitignored, internal). This file is the gitted, externally-
visible surface.

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository, or contact
the maintainer directly rather than filing a public issue. We aim to
acknowledge reports within a few business days.

## Known limitations

The items below are accepted limitations of the current release. They are
documented here so operators can choose a deployment shape that compensates
for them; they are not bugs.

**Qdrant write-access threat (v0.7+):** the embedding-provider stamp is stored as a doc inside the active Qdrant collection (`metadata.id: '_um_embedding_stamp'`). An actor with Qdrant write access can rewrite this stamp to bypass the §6.2 startup-guard mismatch detection. v0.7 ships without Qdrant auth; the assumed deployment shape is local-network or container-isolated Qdrant. When Qdrant auth lands (planned post-v1.0), document the auth-required posture and consider a signed-stamp scheme.
