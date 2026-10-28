package backup

import (
	"context"
	"errors"
	"io"
	"strings"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"

	"panel/daemon/internal/tunnel"
)

// S3Config targets any S3-compatible object storage (AWS, MinIO, R2, …).
type S3Config struct {
	// Endpoint host[:port] without scheme, e.g. "s3.eu-central-1.amazonaws.com".
	Endpoint  string `json:"endpoint"`
	Region    string `json:"region,omitempty"`
	Bucket    string `json:"bucket"`
	Prefix    string `json:"prefix,omitempty"`
	AccessKey string `json:"accessKey"`
	SecretKey string `json:"secretKey"`
	// Insecure uses plain http (local MinIO only).
	Insecure  bool `json:"insecure,omitempty"`
	PathStyle bool `json:"pathStyle,omitempty"`
}

type s3Store struct {
	c      *minio.Client
	bucket string
	prefix string
}

func openS3(c S3Config) (Store, error) {
	if c.Endpoint == "" || c.Bucket == "" || c.AccessKey == "" || c.SecretKey == "" {
		return nil, tunnel.BadRequest("s3 target needs endpoint, bucket, accessKey and secretKey")
	}
	if strings.Contains(c.Endpoint, "://") {
		return nil, tunnel.BadRequest("s3 endpoint must not contain a scheme")
	}
	lookup := minio.BucketLookupAuto
	if c.PathStyle {
		lookup = minio.BucketLookupPath
	}
	cl, err := minio.New(c.Endpoint, &minio.Options{
		Creds:        credentials.NewStaticV4(c.AccessKey, c.SecretKey, ""),
		Secure:       !c.Insecure,
		Region:       c.Region,
		BucketLookup: lookup,
	})
	if err != nil {
		return nil, tunnel.BadRequest("s3: " + err.Error())
	}
	prefix := strings.Trim(c.Prefix, "/")
	if prefix != "" {
		if err := ValidKey(prefix); err != nil {
			return nil, tunnel.BadRequest("invalid s3 prefix")
		}
		prefix += "/"
	}
	return &s3Store{c: cl, bucket: c.Bucket, prefix: prefix}, nil
}

func (s *s3Store) Put(ctx context.Context, key string, r io.Reader) error {
	if err := ValidKey(key); err != nil {
		return err
	}
	// Unknown size → multipart upload; 16 MiB parts keep memory bounded.
	_, err := s.c.PutObject(ctx, s.bucket, s.prefix+key, r, -1, minio.PutObjectOptions{
		PartSize:    16 << 20,
		ContentType: "application/zstd",
	})
	return err
}

func (s *s3Store) Get(ctx context.Context, key string) (io.ReadCloser, error) {
	if err := ValidKey(key); err != nil {
		return nil, err
	}
	obj, err := s.c.GetObject(ctx, s.bucket, s.prefix+key, minio.GetObjectOptions{})
	if err != nil {
		return nil, err
	}
	// GetObject is lazy; Stat surfaces "not found" before streaming.
	if _, err := obj.Stat(); err != nil {
		obj.Close()
		var resp minio.ErrorResponse
		if errors.As(err, &resp) && resp.Code == "NoSuchKey" {
			return nil, tunnel.NotFound("backup archive not found")
		}
		return nil, err
	}
	return obj, nil
}

func (s *s3Store) Delete(ctx context.Context, key string) error {
	if err := ValidKey(key); err != nil {
		return err
	}
	return s.c.RemoveObject(ctx, s.bucket, s.prefix+key, minio.RemoveObjectOptions{})
}

func (s *s3Store) Close() error { return nil }
