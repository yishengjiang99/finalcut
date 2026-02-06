all:
	make clean; make build; cp ffmpeg.* ../public
		
clean:
	rm -f ffmpeg.js ffmpeg.wasm

build:
	docker build --target build --output . .