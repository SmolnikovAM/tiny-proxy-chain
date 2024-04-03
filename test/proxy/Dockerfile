FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && \
    apt install -y git build-essential vim net-tools && \
    mkdir -p /3proxy && \
    cd /3proxy && \
    git clone https://github.com/z3apa3a/3proxy && \
    cd 3proxy && \
    ln -s Makefile.Linux Makefile && \
    make && \
    make install

EXPOSE 8080 1080

