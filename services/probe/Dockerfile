FROM golang:1.27.2-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /helself-probe ./cmd/helself-probe \
    && mkdir /probe-data && chown 10001:10001 /probe-data && chmod 700 /probe-data

FROM scratch
COPY --from=build /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /helself-probe /helself-probe
COPY --from=build --chown=10001:10001 /probe-data /data
USER 10001:10001
EXPOSE 8008
ENTRYPOINT ["/helself-probe"]
CMD ["server", "--listen", "0.0.0.0:8008", "--data", "/data/probe.db", "--admin-token-file", "/run/helself/admin-token", "--tls-cert", "/run/helself/tls.crt", "--tls-key", "/run/helself/tls.key"]
